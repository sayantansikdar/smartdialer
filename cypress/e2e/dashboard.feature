@smoke
Feature: Dashboard shell
  As an operator
  I want the dashboard to state its safety posture and reach every view
  So that I always know nothing here places real calls, and can find any control quickly

  Background:
    Given I open the dashboard

  # TEST_CHECKLIST.md row 40
  Scenario: The simulation-mode safety banner is shown above everything
    Then the safety banner says "SIMULATION MODE"
    And the safety banner says "No real calls are placed"

  # TEST_CHECKLIST.md row 39
  Scenario: The live event stream connects without errors
    Then the connection indicator shows "Live"
    And the browser console has no errors

  # TEST_CHECKLIST.md row 52
  Scenario Outline: The "<nav item>" view is reachable from the navigation
    When I navigate to "<nav item>"
    Then the view title contains "<title>"
    And "<nav item>" is the active navigation item

    Examples:
      | nav item      | title         |
      | Dashboard     | Dashboard     |
      | Campaigns     | Campaigns     |
      | Contacts      | Contacts      |
      | Agents        | Agents        |
      | Calls         | Calls         |
      | Simulation    | Simulation    |
      | Provider      | Provider      |
      | System Events | System Events |
