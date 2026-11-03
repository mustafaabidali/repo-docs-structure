# Decision log

Owner rulings that do not need an ADR, one entry each, under a stable `D-NNN` id that a card's scope may cite. Append-only: an entry is never edited; a later entry supersedes it by naming it.

Each entry is a second-level heading made of the id and a short title (`D-001`, `D-002` and so on, never reused), followed by four lines: the date, the ruling in the owner's words or its source, the decision, and how to undo it. The checker fails when a card's scope cites an id that has no heading here.

Architecture decisions with alternatives and consequences are ADRs in `docs/adr/`, not entries here.
