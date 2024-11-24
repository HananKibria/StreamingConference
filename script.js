let rtcConnection;
let polite; // Determines if this peer is polite
let makingOffer = false; // Tracks if the peer is currently making an offer
let ignoreOffer = false; // Tracks if the peer should ignore incoming offers
let isSettingRemoteAnswerPending = false; // Tracks if setting remote answer is pending
let mqttClient;
const localId = Math.floor(Math.random() * 1000000).toString(); // Unique ID for this peer
let localStream; // Make localStream global
const remoteStream = new MediaStream(); // For accumulating remote tracks

// Function to create a new WebRTC connection with Perfect Negotiation logic
function createConnection() {
    const configuration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    rtcConnection = new RTCPeerConnection(configuration);
    console.log('RTCPeerConnection created:', rtcConnection);

    rtcConnection.onnegotiationneeded = async () => {
        try {
            makingOffer = true;
            await rtcConnection.setLocalDescription(await rtcConnection.createOffer());
            console.log('Local offer created and set');
            sendMqttMessage({
                type: 'sdp',
                sdp: rtcConnection.localDescription.sdp,
                sdpType: rtcConnection.localDescription.type
            });
        } catch (err) {
            console.error('Error during negotiationneeded:', err);
        } finally {
            makingOffer = false;
        }
    };

    rtcConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Sending ICE candidate:', event.candidate);
            sendMqttMessage({
                type: 'ice',
                candidate: event.candidate
            });
        }
    };

    rtcConnection.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind);
        remoteStream.addTrack(event.track);
        const remoteVideo = document.getElementById('remoteVideo');
        remoteVideo.srcObject = remoteStream;
    };

    rtcConnection.onsignalingstatechange = () => {
        console.log('Signaling state changed to:', rtcConnection.signalingState);
    };
}

// Function to handle incoming SDP messages with Perfect Negotiation
async function handleSdpMessage(sdp) {
    console.log('Handling SDP message:', sdp.type);
    const offerCollision = sdp.type === 'offer' &&
        (makingOffer || rtcConnection.signalingState !== 'stable');

    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) {
        console.warn('Ignored an incoming offer due to collision');
        return;
    }

    isSettingRemoteAnswerPending = sdp.type === 'answer';
    try {
        await rtcConnection.setRemoteDescription(sdp);
        isSettingRemoteAnswerPending = false;
    } catch (err) {
        console.error('Error setting remote description:', err);
        isSettingRemoteAnswerPending = false;
        return;
    }

    if (sdp.type === 'offer') {
        try {
            await rtcConnection.setLocalDescription(await rtcConnection.createAnswer());
            console.log('Created and set local answer');
            sendMqttMessage({
                type: 'sdp',
                sdp: rtcConnection.localDescription.sdp,
                sdpType: rtcConnection.localDescription.type
            });
        } catch (err) {
            console.error('Error creating and sending answer:', err);
        }
    }
}

// Function to join the conference
async function joinConference() {
    polite = Math.random() < 0.5; // Randomly assign polite flag
    console.log('Polite:', polite);

    mqttClient = mqtt.connect(mqttBroker);
    const meetingId = document.getElementById('meetingId').value;
    const mqttTopic = mqttTopicPrefix + meetingId;

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT broker');
        mqttClient.subscribe(mqttTopic);
    });

    mqttClient.on('message', (topic, message) => {
        const payload = JSON.parse(message);
        if (payload.sender === localId) return; // Ignore self-messages

        console.log('Received message:', payload);

        if (payload.type === 'sdp') {
            handleSdpMessage({
                type: payload.sdpType,
                sdp: payload.sdp
            });
        } else if (payload.type === 'ice') {
            handleIceCandidate(payload.candidate);
        }
    });

    createConnection();
    await setupLocalMedia();
}

// Function to send MQTT message
function sendMqttMessage(payload) {
    const meetingId = document.getElementById('meetingId').value;
    const mqttTopic = mqttTopicPrefix + meetingId;
    payload.sender = localId; // Include sender ID
    mqttClient.publish(mqttTopic, JSON.stringify(payload));
    console.log('Sent message:', payload);
}

// Function to handle ICE candidates
async function handleIceCandidate(candidate) {
    try {
        if (candidate) {
            console.log('Adding received ICE candidate:', candidate);
            await rtcConnection.addIceCandidate(candidate);
            console.log('Added ICE candidate');
        }
    } catch (err) {
        console.error('Error adding ICE candidate:', err);
    }
}

// Function to set up local media (camera and microphone)
async function setupLocalMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;

        // Add tracks to the RTCPeerConnection
        localStream.getTracks().forEach(track => {
            rtcConnection.addTrack(track, localStream);
        });

        console.log('Local media set up and tracks added to RTCPeerConnection');
    } catch (err) {
        console.error('Error accessing local media:', err);
    }
}
