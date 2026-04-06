
// Stub para JUGAYGANA API
const axios = require('axios');

const JUGAYGANA_API_URL = process.env.JUGAYGANA_API_URL || 'https://api.jugaygana.com';
const JUGAYGANA_API_KEY = process.env.JUGAYGANA_API_KEY || '';

async function loginToJugaygana() {
    try {
        return { success: true, token: 'mock-token' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function depositToUser(username, amount, description) {
    try {
        return { 
            success: true, 
            data: { 
                transfer_id: 'TXN-' + Date.now(),
                user_balance_after: 0
            } 
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function withdrawFromUser(username, amount, description) {
    try {
        return { 
            success: true, 
            data: { 
                transfer_id: 'TXN-' + Date.now(),
                user_balance_after: 0
            } 
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

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
    loginToJugaygana,
    depositToUser,
    withdrawFromUser,
    getUserBalance,
    getUserMovements
};