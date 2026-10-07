@safety
Feature: Emergency stop
  As an operator
  I want one control that halts every new call across every campaign
  So that I can stop the dialer immediately when something looks wrong

  Background:
    Given a ready "PROGRESSIVE" campaign "Kill switch" with 4 agents and 100 contacts
    And the campaign is running
    And new calls are being placed for the campaign

  # TEST_CHECKLIST.md row 47
  @smoke
  Scenario: Engaging the emergency stop halts every new call
    Given I open the dashboard
    When I engage the emergency stop
    Then the emergency stop banner is shown
    And the server reports the emergency stop is engaged
    And no new calls are placed for the campaign

  # TEST_CHECKLIST.md row 48
  Scenario: A stopped campaign explains why it is not dialing
    Given the emergency stop has been engaged
    When I open the campaign's detail page
    Then the safety evaluation lists the denial "EMERGENCY_STOP"

  # TEST_CHECKLIST.md row 49
  Scenario: Releasing the emergency stop resumes dialing
    Given I open the dashboard
    And I engage the emergency stop
    And the emergency stop banner is shown
    When I release the emergency stop
    Then the emergency stop banner is gone
    And the server reports the emergency stop is released
    And new calls are being placed for the campaign
