type KeycloakUserRepresentation = {
  id?: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  requiredActions?: string[];
  groups?: string[];
  realmRoles?: string[];
  clientRoles?: Record<string, string[]>;
  federatedIdentities?: unknown[];
  serviceAccountClientId?: string;
};

const fieldsToPreserve: (keyof KeycloakUserRepresentation)[] = [
  'id',
  'username',
  'email',
  'firstName',
  'lastName',
  'enabled',
  'emailVerified',
  'requiredActions',
  'groups',
  'realmRoles',
  'clientRoles',
  'federatedIdentities',
  'serviceAccountClientId',
];

export function buildUserAttributeUpdatePayload(
  kcUser: Record<string, unknown> | null | undefined,
  nextAttributes: Record<string, unknown>
): Record<string, unknown> {
  if (!kcUser || typeof kcUser !== 'object') {
    return { attributes: nextAttributes };
  }

  const payload: Record<string, unknown> = {};
  for (const field of fieldsToPreserve) {
    if (typeof kcUser[field] !== 'undefined') {
      payload[field] = kcUser[field] as unknown;
    }
  }

  payload.attributes = nextAttributes;
  return payload;
}
