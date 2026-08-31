/**
 * Contact management and import.
 *
 * The validation here is a safety control, not a formality. A phone number is the one field
 * in this system that could, in a real deployment, cause a call to reach a person who never
 * consented to one — so it is checked on the way in rather than trusted.
 */

import type { Clock } from '../core/clock.ts';
import { NotFoundError, ValidationError } from '../core/errors.ts';
import { ID_PREFIX, type IdGenerator } from '../core/ids.ts';
import { redactPhoneNumber } from '../core/redact.ts';
import type { CallRepository } from '../db/repositories/call-repository.ts';
import type { ContactRepository } from '../db/repositories/contact-repository.ts';
import type { CallAttempt } from '../domain/call.ts';
import type { Contact, ContactDraft, ContactStatus } from '../domain/contact.ts';
import type { EventService } from './event-service.ts';

/**
 * E.164-ish: an optional leading `+` then 7-15 digits, with spaces, dashes and parentheses
 * tolerated as formatting. Deliberately permissive about punctuation and strict about
 * content — a "number" containing letters is a data error, not a formatting quirk.
 */
const PHONE_PATTERN = /^\+?[0-9]{7,15}$/;

export interface ContactImportResult {
  readonly created: number;
  readonly rejected: ReadonlyArray<{ index: number; reason: string }>;
  readonly contacts: readonly Contact[];
}

export class ContactService {
  readonly #contacts: ContactRepository;
  readonly #calls: CallRepository;
  readonly #events: EventService;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(options: {
    contacts: ContactRepository;
    calls: CallRepository;
    events: EventService;
    clock: Clock;
    ids: IdGenerator;
  }) {
    this.#contacts = options.contacts;
    this.#calls = options.calls;
    this.#events = options.events;
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  static normalizePhoneNumber(raw: string): string {
    return raw.replace(/[\s\-()./]/g, '');
  }

  static isValidPhoneNumber(raw: string): boolean {
    return PHONE_PATTERN.test(ContactService.normalizePhoneNumber(raw));
  }

  create(draft: ContactDraft): Contact {
    const normalized = ContactService.normalizePhoneNumber(draft.phoneNumber);
    if (!ContactService.isValidPhoneNumber(normalized)) {
      // The redacted form appears in the error so a bad import can be diagnosed without the
      // number itself ending up in a log or an API response.
      throw new ValidationError(
        `Invalid phone number: ${redactPhoneNumber(draft.phoneNumber)}`,
        { phoneNumber: redactPhoneNumber(draft.phoneNumber) },
      );
    }
    if (draft.name.trim() === '') {
      throw new ValidationError('Contact name must not be empty');
    }

    return this.#contacts.insert(
      this.#ids.next(ID_PREFIX.contact),
      { ...draft, phoneNumber: normalized },
      this.#clock.now(),
    );
  }

  /**
   * Import many contacts, keeping the good ones.
   *
   * A single malformed row must not discard an otherwise valid import of a thousand — but
   * the rejected rows are reported precisely, by index and reason, so nothing disappears
   * quietly.
   */
  importMany(drafts: readonly ContactDraft[]): ContactImportResult {
    const contacts: Contact[] = [];
    const rejected: Array<{ index: number; reason: string }> = [];

    drafts.forEach((draft, index) => {
      try {
        contacts.push(this.create(draft));
      } catch (error) {
        rejected.push({
          index,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return { created: contacts.length, rejected, contacts };
  }

  get(id: string): Contact {
    const contact = this.#contacts.findById(id);
    if (contact === null) throw new NotFoundError('Contact', id);
    return contact;
  }

  search(filter: {
    campaignId?: string;
    status?: ContactStatus;
    query?: string;
    limit?: number;
    offset?: number;
  }): Contact[] {
    return this.#contacts.search(filter);
  }

  attempts(contactId: string): CallAttempt[] {
    return this.#calls.listAttemptsForContact(contactId);
  }

  /**
   * Mark a contact as never to be called.
   *
   * Terminal and irreversible through this API: there is no `unmarkDoNotCall`. Re-enabling
   * calls to someone who asked not to be called is not an operation a dialer should make
   * easy, and in a real system it would require a separate, audited consent record.
   */
  markDoNotCall(id: string, reason = 'Marked do-not-call'): Contact {
    const contact = this.get(id);
    this.#contacts.markDoNotCall(id, this.#clock.now());

    this.#events.emit({
      type: 'contact.exhausted',
      severity: 'warn',
      message: `Contact marked DO_NOT_CALL: ${reason}`,
      campaignId: contact.campaignId,
      contactId: id,
      metadata: { reason, previousStatus: contact.status },
    });
    this.#events.flush();
    return this.get(id);
  }

  counts(campaignId: string): ReturnType<ContactRepository['counts']> {
    return this.#contacts.counts(campaignId);
  }
}
