import { initializeApp } from "firebase/app";
import { getMessaging, getToken, onMessage } from 'firebase/messaging';

const firebaseConfig = {
	apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
	authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
	projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
	storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
	messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
	appId: process.env.REACT_APP_FIREBASE_APP_ID,
	measurementId: process.env.REACT_APP_FIREBASE_MEASUREMENT_ID
};


// Initialize Firebase
export const firebase = initializeApp(firebaseConfig);

const messaging = getMessaging();

export const requestForToken = async () => {
	try {
		const currentToken = await getToken(messaging, { vapidKey:process.env.VAPIDKEY });
		if (currentToken) {
			console.log('current token for client: ', currentToken);
			return (currentToken);
		} else {
			// Show permission request UI
			console.log('No registration token available. Request permission to generate one.');
		}
	} catch (err) {
		console.log('An error occurred while retrieving token. ', err);
	}
};

export const onMessageListener = () =>
	new Promise((resolve) => {
		onMessage(messaging, (payload) => {
			resolve(payload);
		});
	});