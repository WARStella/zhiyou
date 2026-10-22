'use strict';

const C = require('./repo/collections');
const POLICY_VERSION = 'location-sharing-2026-10-15-v1';
const PURPOSE = 'crew_location_sharing';

function hasLocationConsent(member) {
  return Boolean(member && member.locationSharing !== false &&
    member.locationConsentPolicyVersion === POLICY_VERSION && member.locationConsentId);
}

async function recordLocationConsent(tx, ctx, crewId, member, granted, source) {
  const now = new Date(ctx.now || Date.now());
  const record = await tx.insert(C.PRIVACY_CONSENTS, {
    userId: member.userId, crewId, scope: 'location', purpose: PURPOSE,
    policyVersion: granted ? POLICY_VERSION : member.locationConsentPolicyVersion || POLICY_VERSION,
    granted, source,
    actorUserId: ctx.openid, recordedAt: now,
    grantedAt: granted ? now : member.locationConsentGrantedAt || null,
    revokedAt: granted ? null : now,
  });
  return { locationSharing: granted, locationConsentId: record._id,
    locationConsentPolicyVersion: granted ? POLICY_VERSION : null,
    locationConsentGrantedAt: granted ? now : null };
}

module.exports = { POLICY_VERSION, PURPOSE, hasLocationConsent, recordLocationConsent };
