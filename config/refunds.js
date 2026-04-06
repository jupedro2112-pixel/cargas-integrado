
// Stub para refunds

async function getRefundClaims() {
    return [];
}

async function createRefundClaim(data) {
    return { success: true };
}

async function updateRefundClaim(id, data) {
    return { success: true };
}

module.exports = {
    getRefundClaims,
    createRefundClaim,
    updateRefundClaim
};