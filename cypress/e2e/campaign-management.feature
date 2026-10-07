Feature: Campaign management
  As a campaign manager
  I want to create campaigns from the dashboard with their limits validated
  So that an unsafe dialing configuration never reaches the dialer

  Background:
    Given I am on the campaigns page

  @smoke
  Scenario: Create a progressive campaign
    When I create a "PROGRESSIVE" campaign named "Q4 Win-back"
    Then the campaign "Q4 Win-back" is listed with status "DRAFT" and mode "PROGRESSIVE"
    And the server has the campaign "Q4 Win-back" in status "DRAFT"

  Scenario: Create a predictive campaign
    When I create a "PREDICTIVE" campaign named "New Product Outreach"
    Then the campaign "New Product Outreach" is listed with status "DRAFT" and mode "PREDICTIVE"

  Scenario Outline: The form refuses an unsafe "<field>"
    When I start a new campaign named "Unsafe config"
    And I set the "<field>" field to "<value>"
    And I submit the new campaign
    Then the "<field>" field shows the error "<error>"
    And no campaign named "Unsafe config" exists on the server

    Examples:
      | field                  | value | error                                       |
      | Name                   |       | Required.                                   |
      | Max concurrent calls   | 0     | Must be a whole number of at least 1.       |
      | Max calls / second     | 0     | Must be greater than 0.                     |
      | Max abandon rate       | 3     | A proportion between 0 and 1 (0.03 = 3%).   |
      | Max attempts / contact | 0     | At least 1 — zero attempts would never dial. |

  # Client-side validation is a convenience, never the guarantee.
  @api
  Scenario: The server refuses an unsafe campaign even when the form is bypassed
    When a client posts a campaign with a max abandon rate of 3 straight to the API
    Then the API rejects it with status 400 and error code "VALIDATION_FAILED"
