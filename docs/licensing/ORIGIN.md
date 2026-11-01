# Source lineage and license decision

The project owner requested an independent repository under the `351labs` organization and selected Apache-2.0 for CarLab's original work on 1 November 2026. `LICENSE`, `NOTICE` and the package metadata record that decision. This document records the instructions and technical provenance; it is not a copyright-assignment instrument or an employment-contract audit.

## What is evidenced by the repository

- The independent application was imported in commit `cdf5c10071cb55428723dc46234531d0b0ebd763` from the preceding engine laboratory developed in the same owner-directed workflow.
- The seven bundled synthetic comparison WAVs have an explicit historical-model/configuration/processing/checksum record in `public/audio/PROVENANCE.json`. They are historical procedural renders, not claims of byte-for-byte reproduction by the current model.
- The third-party recording, coefficient data, dependency code and EPA numeric data have separate attribution and terms in `credits.md` and the distribution notices. The owner's Apache decision does not relicense that material.
- Commit author identity is retained. Its e-mail domain identifies the Git identity used; it does not, by itself, establish an employer's ownership, a copyright transfer or a conflict with the `NOTICE` attribution.

## Interpretation of review item B1

The independent review correctly distinguished B1 as an inference. It did not identify a competing copyright claim, an assignment agreement, third-party employer code or unauthorized commercial assets. Its request for an ownership statement concerns information that cannot be established solely from Git author metadata or a change of repository name.

The relevant Apache-2.0 definition is that the licensor holds the rights or is authorized by the holder; see the [official license, section 1](https://www.apache.org/licenses/LICENSE-2.0). The owner's choice of license is already recorded and is not reopened here. Any actual contractual ownership restriction would need to be evaluated on its own facts. No such contract is evidenced by this repository, and no assignment is invented or inferred from an e-mail address.

No Git history was rewritten to disguise lineage or change the recorded author. Historical hostname fields in saved browser proofs were redacted as labeled privacy metadata; test outcomes remain intact.
