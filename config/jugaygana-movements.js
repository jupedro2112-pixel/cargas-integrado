
// Stub para JUGAYGANA Movimientos

async function getUserBalance(username) {
    try {
        return { success: true, balance: 0 };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function getUserMovements(username, options = {}) {
    try {
        return { 
            success: true, 
            movements: [],
            pagination: { page: 1, pageSize: 50, total: 0 }
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = {
    getUserBalance,
    getUserMovements
};