@safety
Feature: Do-not-call protection
  As a compliance officer
  I want do-not-call contacts never to be dialled
  So that the dialer cannot reach someone who asked not to be called

  # TEST_CHECKLIST.md row 50
  Scenario: A campaign runs to completion without dialling a do-not-call contact
    Given a ready "PROGRESSIVE" campaign "DNC guard" with 4 agents and 12 contacts, 4 of them do-not-call
    And I am on the campaigns page
    When I press "Start" for the campaign "DNC guard"
    Then the campaign "DNC guard" eventually shows status "COMPLETED"
    And no call was ever placed to a do-not-call contact
    And every do-not-call contact is still marked "DO_NOT_CALL"
    And the system invariants still hold
