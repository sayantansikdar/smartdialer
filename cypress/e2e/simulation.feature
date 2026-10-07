Feature: Simulation scenarios
  As a test engineer
  I want to run the predefined chaos scenarios and custom simulations from the dashboard
  So that I can check the dialer's invariants without waiting for a live campaign

  Background:
    Given I am on the simulation page

  # TEST_CHECKLIST.md row 51
  Scenario Outline: The "<scenario>" scenario demonstrates its claim with every invariant intact
    When I run the "<scenario>" scenario
    Then the report verdict is "INVARIANTS: PASSED"
    And the report is for scenario "<scenario>"
    And the scenario demonstrated what it claims

    @smoke
    Examples: Core behaviour
      | scenario    |
      | progressive |
      | dnc         |

    Examples: Failure and safety handling
      | scenario       |
      | timeout        |
      | emergency-stop |
      | race           |
      | provider-fail  |

  # TEST_CHECKLIST.md row 38, through the UI
  Scenario: A custom simulation replays identically from the same seed
    When I set the simulation "Seed" to "4242"
    And I run the custom simulation
    Then the report verdict is "INVARIANTS: PASSED"
    And the report is for a custom run with seed "4242"
    When I run the custom simulation again
    Then both runs produced the same result
