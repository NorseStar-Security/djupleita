---
kind: upgrade-guide
description: "Course scope policies now reject Unicode DNS rules and require explicit ASCII/Punycode names."
---

# Scope policies require explicit ASCII/Punycode names

English | [中文](guide.zh.md)

## Change

The course gateway previously accepted Unicode DNS rules and converted them with Python's IDNA codec. The recon provider uses a different hostname normalization. Some Unicode names could therefore identify different hosts across the two checks, confusing research grants with operational exceptions.

The gateway now rejects non-ASCII names in `domains`, `exclude_domains`, `infrastructure`, and `domain_addresses`. The recon provider also rejects non-ASCII target grant and exclusion rules. Instructors using Unicode names must update their policy. ASCII/Punycode policies need no change. Unicode recon tool inputs remain supported against explicit Punycode grants; request hostname normalization is unchanged.

## Migration

1. Stop the course environment before editing `course/scope-runtime/scope.json`:

   ```sh
   docker compose -f course/scope-runtime/compose.yml down
   ```

2. Review each non-ASCII entry in `domains` and `exclude_domains`, and each non-ASCII key in `infrastructure` and `domain_addresses`. Replace it with the intended DNS A-label. For example, use `xn--fa-hia.test` for `faß.test`, not the different name `fass.test`. Preserve an existing `*.` prefix when converting a wildcard suffix. Review the intended hostname rather than automatically accepting a codec's result; do not add alternate hosts or expand permissions.

3. Rebuild with `docker compose -f course/scope-runtime/compose.yml build`, then restart with `docker compose -f course/scope-runtime/compose.yml up -d --wait gateway`. Invalid names prevent startup. Inspect the immutable policy through `scope_status` and confirm its grants, exclusions, and operational exceptions match the intended ASCII names before resuming research. See the [runtime reference](../../../../course/scope-runtime/README.md#policy-reference) for policy fields and boundary verification.
