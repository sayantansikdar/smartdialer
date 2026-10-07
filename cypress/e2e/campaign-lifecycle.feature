Feature: Campaign lifecycle controls
  As a campaign manager
  I want start, pause, resume and stop to perform the real transition
  So that what the dashboard shows is what the dialer is actually doing

  Background:
    Given a ready "PROGRESSIVE" campaign "Lifecycle" with 4 agents and 100 contacts

  # TEST_CHECKLIST.md row 41
  @smoke
  Scenario: Starting a campaign from the list begins dialing
    Given I am on the campaigns page
    When I press "Start" for the campaign "Lifecycle"
    Then the campaign "Lifecycle" is listed with status "RUNNING"
    And the server reports the campaign is "RUNNING"
    And new calls are being placed for the campaign

  # TEST_CHECKLIST.md rows 42 and 72
  Scenario: The detail page explains its pacing decision
    Given the campaign is running
    When I open the campaign's detail page
    Then the pacing explanation shows the engine's request and the safety controller's verdict

  # TEST_CHECKLIST.md rows 43 and 44
  Scenario: Pausing halts new dialing and resuming restarts it
    Given the campaign is running
    And new calls are being placed for the campaign
    When I open the campaign's detail page
    And I press "Pause" on the campaign detail page
    Then the campaign detail status is "PAUSED"
    And the server reports the campaign is "PAUSED"
    And no new calls are placed for the campaign
    When I press "Resume" on the campaign detail page
    Then the campaign detail status is "RUNNING"
    And new calls are being placed for the campaign

  Scenario: Stopping a campaign ends it
    Given the campaign is running
    When I open the campaign's detail page
    And I press "Stop" on the campaign detail page
    Then the campaign detail status is "STOPPED"
    And the server reports the campaign is "STOPPED"
    And the campaign has no calls in flight
