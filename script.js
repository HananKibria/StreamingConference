// script.js

let mqttClient;
let localId;
const peers = {}; // Object to hold RTCPeerConnections keyed by peer ID
const peerStreams = {}; // Object to hold MediaStreams from each peer
const remoteVideoContainers = {}; // Object to hold video elements for each peer
let localStream; // Global variable for local media stream
const peerActivity = {}; // Object to track the last activity time of peers

// Generate a unique ID for this peer
function generateUniqueId() {
    return Math.floor(Math.random() * 1000000).toString();
}

localId = generateUniqueId();
console.log('Local ID:', localId);

// Function to create a new RTCPeerConnection with a peer
function createPeerConnection(peerId) {
    const configuration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    const peerConnection = new RTCPeerConnection(configuration);
    console.log(`RTCPeerConnection created for peer ${peerId}:`, peerConnection);

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`Sending ICE candidate to peer ${peerId}:`, event.candidate);
            sendMqttMessage({
                type: 'ice',
                candidate: event.candidate
            }, peerId);
        }
    };

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
        console.log(`Received remote track from peer ${peerId}:`, event.track.kind);
        if (!peerStreams[peerId]) {
            peerStreams[peerId] = new MediaStream();
        }
        peerStreams[peerId].addTrack(event.track);
        attachRemoteStream(peerId, peerStreams[peerId]);
    };

    // Handle negotiation needed
    peerConnection.onnegotiationneeded = async () => {
        console.log(`Negotiation needed with peer ${peerId}`);
        await makeOffer(peerId);
    };

    // Handle connection state change
    peerConnection.onconnectionstatechange = () => {
        console.log(`Connection state with peer ${peerId}: ${peerConnection.connectionState}`);
        if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
            removePeer(peerId);
        }
    };

    return peerConnection;
}

// Function to initiate connection with a new peer
function initiateConnectionWithPeer(peerId) {
    // Avoid duplicate connections
    if (peers[peerId]) return;

    console.log(`Initiating connection with peer ${peerId}`);

    // Create a new RTCPeerConnection for this peer
    const peerConnection = createPeerConnection(peerId);
    peers[peerId] = peerConnection;

    // Add local tracks to the connection
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Start negotiation if needed
    if (peerConnection.signalingState === 'stable') {
        makeOffer(peerId);
    }

    // Initialize peer activity timestamp
    peerActivity[peerId] = Date.now();
}

// Function to make an offer to a peer
async function makeOffer(peerId) {
    const peerConnection = peers[peerId];
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        console.log(`Created and set local offer for peer ${peerId}`);
        sendMqttMessage({
            type: 'sdp',
            sdp: peerConnection.localDescription.sdp,
            sdpType: peerConnection.localDescription.type
        }, peerId);
    } catch (err) {
        console.error(`Error creating offer for peer ${peerId}:`, err);
    }
}

// Function to handle incoming SDP messages
async function handleSdpMessage(peerId, sdp) {
    const peerConnection = peers[peerId] || createPeerConnection(peerId);
    peers[peerId] = peerConnection;

    try {
        await peerConnection.setRemoteDescription(sdp);
        console.log(`Set remote description for peer ${peerId}`);

        if (sdp.type === 'offer') {
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            console.log(`Created and set local answer for peer ${peerId}`);
            sendMqttMessage({
                type: 'sdp',
                sdp: peerConnection.localDescription.sdp,
                sdpType: peerConnection.localDescription.type
            }, peerId);
        }
    } catch (err) {
        console.error(`Error handling SDP message for peer ${peerId}:`, err);
    }
}

// Function to handle ICE candidates
async function handleIceCandidate(peerId, candidate) {
    const peerConnection = peers[peerId];
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(candidate);
            console.log(`Added ICE candidate for peer ${peerId}`);
        } catch (err) {
            console.error(`Error adding ICE candidate for peer ${peerId}:`, err);
        }
    } else {
        console.warn(`PeerConnection not found for peer ${peerId}`);
    }
}

// Function to attach a remote stream to a video element
function attachRemoteStream(peerId, stream) {
    let remoteVideo = remoteVideoContainers[peerId];
    if (!remoteVideo) {
        remoteVideo = document.createElement('div');
        remoteVideo.classList.add('video-wrapper');

        const videoHeader = document.createElement('h2');
        videoHeader.textContent = `Participant ${peerId}`;
        remoteVideo.appendChild(videoHeader);

        const videoElement = document.createElement('video');
        videoElement.id = `remoteVideo_${peerId}`;
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        remoteVideo.appendChild(videoElement);

        document.getElementById('remoteVideos').appendChild(remoteVideo);
        remoteVideoContainers[peerId] = videoElement;
    }
    remoteVideoContainers[peerId].srcObject = stream;
}

// Function to send MQTT message
function sendMqttMessage(payload, recipientId = null) {
    const meetingId = document.getElementById('meetingId').value;
    const mqttTopic = mqttTopicPrefix + meetingId;
    payload.sender = localId;
    payload.recipient = recipientId; // Null means broadcast to all
    mqttClient.publish(mqttTopic, JSON.stringify(payload));
    console.log('Sent message:', payload);
}

// Function to join the conference
async function joinConference() {
    mqttClient = mqtt.connect(mqttBroker);
    const meetingId = document.getElementById('meetingId').value;
    const mqttTopic = mqttTopicPrefix + meetingId;

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT broker');
        mqttClient.subscribe(mqttTopic);

        // Announce presence to other peers
        sendMqttMessage({ type: 'new-peer' });
    });

    mqttClient.on('message', (topic, message) => {
        const payload = JSON.parse(message);
        if (payload.sender === localId) return; // Ignore self-messages
        if (payload.recipient && payload.recipient !== localId) return; // Ignore messages not intended for this peer

        console.log('Received message:', payload);

        const senderId = payload.sender;

        // Update peer activity timestamp
        peerActivity[senderId] = Date.now();

        if (payload.type === 'new-peer') {
            // A new peer has joined; initiate connection
            initiateConnectionWithPeer(senderId);

            // Inform the new peer about existing peers
            if (!payload.recipient) {
                sendMqttMessage({ type: 'new-peer' }, senderId);
            }
        } else if (payload.type === 'sdp') {
            handleSdpMessage(senderId, {
                type: payload.sdpType,
                sdp: payload.sdp
            });
        } else if (payload.type === 'ice') {
            handleIceCandidate(senderId, payload.candidate);
        } else if (payload.type === 'leave') {
            // Handle peer leaving the conference
            console.log(`Peer ${senderId} has left the conference`);
            removePeer(senderId);
        }
    });

    await setupLocalMedia();

    // Start monitoring peer activity
    setInterval(checkPeerActivity, 10000); // Check every 10 seconds

    // Handle page unload to send "leave" message
    window.addEventListener('beforeunload', () => {
        sendMqttMessage({ type: 'leave' });
        closeAllConnections();
    });
}

// Function to set up local media (camera and microphone)
async function setupLocalMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;
        console.log('Local media set up');
    } catch (err) {
        console.error('Error accessing local media:', err);
    }
}

// Function to remove a peer when they leave
function removePeer(peerId) {
    console.log(`Removing peer ${peerId}`);

    // Close the RTCPeerConnection
    if (peers[peerId]) {
        peers[peerId].close();
        delete peers[peerId];
    }

    // Remove the video element
    if (remoteVideoContainers[peerId]) {
        const videoWrapper = remoteVideoContainers[peerId].parentElement;
        videoWrapper.parentElement.removeChild(videoWrapper);
        delete remoteVideoContainers[peerId];
    }

    // Remove the media stream
    if (peerStreams[peerId]) {
        peerStreams[peerId].getTracks().forEach(track => track.stop());
        delete peerStreams[peerId];
    }

    // Remove peer activity tracking
    if (peerActivity[peerId]) {
        delete peerActivity[peerId];
    }
}

// Function to check peer activity and remove inactive peers
function checkPeerActivity() {
    const currentTime = Date.now();
    const timeout = 30000; // 30 seconds timeout

    for (const peerId in peerActivity) {
        if (currentTime - peerActivity[peerId] > timeout) {
            console.log(`Peer ${peerId} is inactive and will be removed`);
            removePeer(peerId);
        }
    }
}

// Function to close all connections when leaving the conference
function closeAllConnections() {
    for (const peerId in peers) {
        if (peers[peerId]) {
            peers[peerId].close();
        }
    }
}

// Add event listener to the Join Conference button
document.getElementById('joinButton').addEventListener('click', () => {
    joinConference();
});

// Define the MQTT broker URL and topic prefix
const mqttBroker = 'wss://mqtt-dashboard.com:8884/mqtt'; // Replace with your MQTT broker URL
const mqttTopicPrefix = 'webrtc/';
