---
id: fastbrain-decision-protocol
title: FastBrain shared decision protocol
summary: Eighteen policy decisions share one host-owned adapter; knowledge and catalog entries never confer execution authority.
tags: [FastBrain, decision, protocol]
---

The public call names are `observe`, `search`, `explore`, `move_to`, `mine`, `pickup`, `place`, `craft`, `smelt`, `collect_output`, `equip`, `attack`, `retreat`, `consume`, `wait`, and `cancel`.

The terminal declarations are `finish` and `report_blocked`. Declarations go to an independent outcome verifier, never directly to a device.

The expert and model see the same eighteen-name menu. The host binds session, request, identity, observation freshness and deadline. Policy JSON grants no device authority. An entry is not proof of an implementation: check availability in DecisionPort.catalog().

The initial adapter delivery returns self-only partial observations. Spatial visibility, visible target binding and production body handlers remain unavailable. It does not reinterpret legacy craft counts or the legacy all-in-one smelt operation.

Knowledge helps a caller understand the protocol; it grants no body permission. Missing handlers return blocked rather than executing an alias or pretending success.
