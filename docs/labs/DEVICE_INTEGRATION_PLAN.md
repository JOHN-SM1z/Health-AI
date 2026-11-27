# Laboratory device integration plan

Scope decision, 2026-10-06: automate private-clinic operations; defer payroll. This is a proposed implementation plan, not a claim that an analyzer is connected. No clinic device inventory, host-interface manual or sample message has been supplied yet.

## Shared core, incremental connections

Use one workflow: clinician order → specimen/barcode → collection → device processing → matched draft results → authorized verification/release → secure patient delivery. Keep order, specimen, analytical run, result version, release and delivery states separate. An acknowledged device transfer is not a verified result or proof of patient delivery.

IHE's Laboratory Analytical Workflow describes information exchange between analyzers and analyzer managers, including laboratory orders and results. It provides an interoperability framework; it does not prove that a specific clinic's device implements it. Consult the current [IHE PaLM framework](https://profiles.ihe.net/PaLM/index.html) and [LAW overview](https://wiki.ihe.net/index.php/Laboratory_Analytical_Workflow_Profile).

Proposed architecture:

```text
Analyzer(s) ↔ supported vendor middleware OR local device gateway
            ↔ authenticated clinic integration API
            ↔ orders / specimens / versioned results
            → authorized verification → release → delivery jobs
```

Prefer an existing supported middleware interface where available. Reuse protocol adapters across compatible devices, but validate model, firmware, settings and mappings for each installation. Depending on the manufacturer's documented interface, transport may be serial or network and messages may use HL7, ASTM or a proprietary format. Do not infer protocol, port or bidirectional capability from the brand. A model/software-specific [Roche host-interface manual](https://diagnostics.roche.com/content/dam/diagnostics/us/en/products/c/cobas-liat-support/cobas-liat-system-him-poct1-a_-sw-ver.-3.3_ver.-5.2.pdf) illustrates why the actual interface documentation is needed; it is not a proposed device selection.

## First-device information

Record manufacturer, exact model, serial/asset identifier, software/firmware version, supported host-interface specification, connection type, existing LIS/middleware, interface licence/activation requirements and vendor contact. Obtain synthetic or de-identified example messages, test catalogue mappings, units, flags, sample barcode rules and supported acknowledgement/retry behavior. Keep patient-bearing raw messages and credentials out of repository files and logs.

Select the first device using observed volume, manual transcription burden, available documentation and a usable test environment. The first implementation can receive results only if that is the documented capability; enable outbound order/worklist transfer only after separate validation. Do not advertise bidirectional automation for a result-only device.

## Core requirements before a live connection

- Server-issued specimen/container identifiers bind to the clinic, patient, order and sample type. Never match a result by patient name alone. Unknown, duplicate or ambiguous identities go to an exception queue.
- Versioned device/test-code mappings define the corresponding ordered test, units and supported result types. Preserve reported values, units, flags, timestamps and source identity. Do not silently convert units or invent reference ranges; approved mappings govern transformations.
- An authenticated device/gateway identity is bound to one clinic and allowed devices. It cannot choose another tenant or acquire clinical release privileges. Keep device networks private; a local gateway may buffer transfers durably during outages.
- Use protocol-specific acknowledgement rules with durable receipt before confirming acceptance. Handle retransmissions idempotently; retain distinct reruns and corrected results instead of discarding them as duplicates. Track immutable provenance and amendments.
- Separate patient results from quality-control/calibration traffic. Incomplete panels, instrument flags, mapping errors, missing orders and unavailable devices require visible handling. No automatic clinical interpretation or clinical AI.
- Qualified, authorized staff verify and release results under documented clinic policy. Imported output begins unreleased. Critical-value escalation and release/withdrawal rules require clinical ownership; the software must not invent thresholds.
- Audit receipt, matching, corrections, verification, release and delivery. Restrict and encrypt raw-message storage with an explicit retention policy. Ordinary logs contain technical identifiers rather than clinical payloads.

## Per-device rollout and acceptance

1. Confirm interface access and the exact specification with the clinic/vendor. Document ownership of device settings and downtime recovery.
2. Build a parser/adapter against recorded synthetic fixtures or a simulator. Test malformed frames, partial messages, acknowledgements, retries, disconnects and unsupported codes.
3. Validate mappings and identity using known specimens in an approved test environment. Compare every supported result type with the device output, including decimals, units, flags, panels, reruns and corrections.
4. Run a monitored comparison with the existing workflow. Reconcile ordered tests, received results and approved reports; an unmatched result must never be silently attached to another patient.
5. Enable that connection only after laboratory sign-off. Monitor last contact, backlog, unmatched samples, failures and unreleased results. Maintain an audited manual fallback and a disable/rollback path without losing received data.
6. Repeat validation for the next installation. Adapter reuse reduces engineering effort; it does not remove acceptance testing after device/software/mapping changes.

## Dependencies and honest completion criteria

The first deliverable is a working order/specimen/result workflow plus one validated device connection. Other devices remain explicitly manual or unsupported until validated. Receiving every requested result, completing authorized release and confirming actual delivery are separate measurable milestones. No payroll feature is required to release this operational scope.

Device-specific implementation depends on the first model's inventory and interface evidence. The generic laboratory core can proceed independently. This document adds no runtime adapter, clinical schema or production configuration.
