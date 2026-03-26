const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let fcmInitialized = false;

const initFCM = () => {
    try {
        if (process.env.FIREBASE_CREDENTIALS) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            fcmInitialized = true;
            return;
        }

        const serviceAccountPath = path.join(__dirname, '../../firebase-service-account.json');
        if (fs.existsSync(serviceAccountPath)) {
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            fcmInitialized = true;
        } else {
            console.warn('Firebase service account file not found at:', serviceAccountPath);
            console.warn('Please provide FIREBASE_CREDENTIALS in .env or firebase-service-account.json in the project root.');
        }
    } catch (error) {
        console.error('Error initializing Firebase Admin SDK:', error.message);
    }
};

initFCM();

const sendNotification = async (token, title, body, data = {}) => {
    if (!fcmInitialized) {
        console.warn('FCM NOT INITIALIZED: Cannot send notification');
        return null;
    }
    if (!token) {
        return null;
    }

    const message = {
        notification: {
            title,
            body
        },
        data: {
            ...data,
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        token
    };

    try {
        const response = await admin.messaging().send(message);
        return response;
    } catch (error) {
        if (error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/invalid-registration-token') {
            console.warn('Invalid FCM token, skipping...');
            return null;
        }
        console.error('Error sending FCM message:', error.message);
        throw error;
    }
};

module.exports = { sendNotification };
