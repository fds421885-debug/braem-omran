export const DIRTY_DOZEN_CASES = [
  { id: 1, name: 'Unauthenticated get on /accounts/acc1', expected: 'PERMISSION_DENIED' },
  { id: 2, name: 'Non-admin list of /accounts without uid/email match', expected: 'PERMISSION_DENIED' },
  { id: 3, name: 'Non-admin create on /complexes/c1', expected: 'PERMISSION_DENIED' },
  { id: 4, name: 'Self-elevation to platform_admin with wrong name', expected: 'PERMISSION_DENIED' },
  { id: 5, name: 'Self-elevation to supervisor without valid inviteToken', expected: 'PERMISSION_DENIED' },
  { id: 6, name: 'Overwrite attempt on /nameIndex/{hash}', expected: 'PERMISSION_DENIED' },
  { id: 7, name: 'Create /accounts with email_verified = false', expected: 'PERMISSION_DENIED' },
  { id: 8, name: 'Non-admin delete on /inviteLinks/{token}', expected: 'PERMISSION_DENIED' },
  { id: 9, name: 'Non-admin modifying recitedAyahs on /stats', expected: 'PERMISSION_DENIED' },
  { id: 10, name: 'Non-admin incrementing studentLogins by +50', expected: 'PERMISSION_DENIED' },
  { id: 11, name: 'Shadow field injection on /complexes or /accounts', expected: 'PERMISSION_DENIED' },
  { id: 12, name: 'Client-forged createdAt timestamp on /accounts', expected: 'PERMISSION_DENIED' },
] as const;
