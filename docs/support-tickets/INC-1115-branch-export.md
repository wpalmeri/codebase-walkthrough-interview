# INC-1115: Branch export contained unexpected patients

| Field | Value |
|---|---|
| Reported by | Compliance review (Northstar Home Health), escalated by Support |
| Date reported | 2026-05-20 |
| Severity | SEV-2 (High) — cross-branch record exposure |
| Environment | Production; branch visit export; Northstar Home Health |
| Component | Reporting / branch scoping |
| Status | Open |

## Summary

A user whose access is scoped to the Oakland branch exported a visit list.
Several rows were visits located in San Francisco. The interactive visit list for
the same user did not show those rows.

## Steps to reproduce (as reported)

1. As a user scoped to a single branch (Oakland), open the interactive visit list
   and note the rows shown.
2. Run the branch visit export for the same window.
3. Compare the export against the interactive list.

## Observed

The export includes visits whose current location is San Francisco, which the
interactive page did not display for this user. The two surfaces disagree on which
visits belong to the branch.

## Expected

An export should contain exactly the rows the user is entitled to see, and should
apply the same branch scope as the interactive screen.

## Impact

The customer deleted the export. Because the rows carry patient name and MRN, this
is treated as a potential cross-branch exposure of records. Security has asked for
confirmation of which export paths apply organization, region, branch, and
patient-assignment rules, and whether any of them differ from the interactive
screens.

## Preliminary engineering note (tentative)

Branch membership for the export appears to resolve through
`VisitGroup.branchId`, while a visit relocated with `moveVisitBranch`
(`src/scheduling/schedule-service.ts`) updates only the visit's `locationId` and
leaves the group's branch unchanged. A visit moved to San Francisco would then
keep its original Oakland group branch and stay in the Oakland export even though
its location is now San Francisco. The interactive list and the export also seem
to apply scope at different points (query-level vs after load). Both need
confirmation, and we should decide what the authoritative branch of a relocated
visit is for access and reporting purposes.
