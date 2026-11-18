# Firestore Security Specification — نظام إدارة الحلقات (براعم عمران)

## 1. Data Invariants
1. **Default-Deny Catch-All**: Every path not explicitly matched is denied.
2. **Unique Quadruple Name Lock**: `/nameIndex/{nameHash}` enforces unique quadruple Arabic names (`create` only, no `update`), preventing duplicate registration.
3. **Admin Authority**: Only verified `platform_admin` (`محمد منتصر محمد يونس` / bootstrapped admin) may create/edit/delete complexes, mosques, halaqat, invite links, quick links, and other members' accounts.
4. **PII Isolation**: `/accounts` `get` and `list` restrict access to either `isPlatformAdmin()` or the owning user (`uid`/`email`).
5. **Temporal Integrity**: All `createdAt` and `updatedAt` timestamps must match `request.time`.

## 2. The "Dirty Dozen" Attack Payloads (All Must Fail with PERMISSION_DENIED)
1. Unauthenticated `getDoc(/accounts/acc1)`.
2. Non-admin `list` of `/accounts` attempting to read other members' PII.
3. Non-admin creating `/complexes/c1` or `/mosques/m1` or `/halaqat/h1`.
4. Non-admin self-assigning `role: 'platform_admin'` with a different `quadrupleName`.
5. Non-admin self-assigning `role: 'supervisor'` without a valid `inviteToken` in `/inviteLinks`.
6. Overwriting an existing `/nameIndex/{nameHash}` document (`update`).
7. Creating `/accounts` with `email_verified: false`.
8. Non-admin deleting `/inviteLinks/{token}` or `/quickLinks/{token}`.
9. Non-admin tampering with `recitedAyahs` or `recitedPages` in `/stats/{statId}`.
10. Non-admin incrementing `studentLogins` by `+50` in `/stats/{statId}` (capped at `+1`).
11. Injecting shadow fields like `isSuperUser: true` into `/accounts` or `/complexes`.
12. Forging client timestamps (`createdAt` != `request.time`).
