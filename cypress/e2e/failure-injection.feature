@safety
Feature: Provider failure injection
  As a test engineer
  I want the provider controls to change the live provider
  So that I can prove the dialer recovers from a telecom provider misbehaving

  Background:
    Given a ready "PROGRESSIVE" campaign "Faulty provider" with 4 agents and 100 contacts
    And the campaign is running
    And I am on the provider page

  # TEST_CHECKLIST.md rows 45 and 46
  Scenario: Silenced calls are recovered by the engine watchdog
    When I apply the "All calls go silent" fault
    Then the "Silence rate" control reads "100%"
    And the live provider reports "timeoutRate" as "1"
    And the watchdog times out silent calls for the campaign
    And the system invariants still hold

  Scenario: A provider outage can be injected and cleared
    When I apply the "Provider outage" fault
    Then the live provider reports "outageActive" as "true"
    When I apply the "Reset to healthy" fault
    Then the live provider reports "outageActive" as "false"
    And the "Silence rate" control reads "0%"
    And the system invariants still hold
