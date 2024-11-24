// script.js

let mqttClient;
let localId;
let peers = {}; // Holds RTCPeerConnections keyed by peer ID
let peerStates = {}; // Holds negotiation flags per peer
let peerStreams = {}; // Holds MediaStreams from each peer
let remoteVideoContainers = {}; // Holds video elements for each peer
let localStream; // Global variable for local media stream
let peerActivity = {}; // Tracks the last activity time of peers

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
        const state = peerStates[peerId];
        try {
            state.makingOffer = true;
            await makeOffer(peerId);
        } catch (err) {
            console.error(`Error during negotiation with peer ${peerId}:`, err);
        } finally {
            state.makingOffer = false;
        }
    };

    // Handle connection state change
    peerConnection.onconnectionstatechange = () => {
        console.log(`Connection state with peer ${peerId}: ${peerConnection.connectionState}`);
        if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
            removePeer(peerId);
        }
    };

    return peerConnection;
}

// Function to initiate connection with a new peer
function initiateConnectionWithPeer(peerId) {
    if (peers[peerId]) return;

    console.log(`Initiating connection with peer ${peerId}`);

    // Create a new RTCPeerConnection for this peer
    const peerConnection = createPeerConnection(peerId);
    peers[peerId] = peerConnection;

    // Initialize peer negotiation state
    peerStates[peerId] = {
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        polite: localId < peerId, // The peer with the lower ID is polite
        pendingCandidates: []
    };

    // Add local tracks to the connection if any
    let currentVideoTrack;
    if (isScreenSharing && screenStream && screenStream.getVideoTracks().length > 0) {
        currentVideoTrack = screenStream.getVideoTracks()[0];
    } else if (localStream && localStream.getVideoTracks().length > 0) {
        currentVideoTrack = localStream.getVideoTracks()[0];
    }

    if (currentVideoTrack) {
        peerConnection.addTrack(currentVideoTrack, new MediaStream([currentVideoTrack]));
    }

    // Add audio track if available
    if (localStream && localStream.getAudioTracks().length > 0) {
        const audioTrack = localStream.getAudioTracks()[0];
        peerConnection.addTrack(audioTrack, localStream);
    }

    // Initialize peer activity timestamp
    peerActivity[peerId] = Date.now();
}

// Function to make an offer to a peer
async function makeOffer(peerId) {
    const peerConnection = peers[peerId];
    const state = peerStates[peerId];

    try {
        state.makingOffer = true;
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
    } finally {
        state.makingOffer = false;
    }
}

// Function to handle incoming SDP messages
async function handleSdpMessage(peerId, sdp) {
    const peerConnection = peers[peerId] || createPeerConnection(peerId);
    peers[peerId] = peerConnection;
    const state = peerStates[peerId];

    const offerCollision = sdp.type === 'offer' &&
        (state.makingOffer || peerConnection.signalingState !== 'stable');

    state.ignoreOffer = !state.polite && offerCollision;
    if (state.ignoreOffer) {
        console.warn(`Ignored an incoming offer from peer ${peerId} due to collision`);
        return;
    }

    state.isSettingRemoteAnswerPending = sdp.type === 'answer';
    try {
        await peerConnection.setRemoteDescription(sdp);
        state.isSettingRemoteAnswerPending = false;

        // Process any buffered ICE candidates
        if (state.pendingCandidates.length > 0) {
            console.log(`Adding buffered ICE candidates for peer ${peerId}`);
            for (const candidate of state.pendingCandidates) {
                await peerConnection.addIceCandidate(candidate);
                console.log(`Added buffered ICE candidate for peer ${peerId}`);
            }
            state.pendingCandidates = [];
        }

    } catch (err) {
        console.error(`Error setting remote description for peer ${peerId}:`, err);
        state.isSettingRemoteAnswerPending = false;
        return;
    }

    if (sdp.type === 'offer') {
        try {
            await peerConnection.setLocalDescription(await peerConnection.createAnswer());
            console.log(`Created and set local answer for peer ${peerId}`);
            sendMqttMessage({
                type: 'sdp',
                sdp: peerConnection.localDescription.sdp,
                sdpType: peerConnection.localDescription.type
            }, peerId);
        } catch (err) {
            console.error(`Error creating and sending answer to peer ${peerId}:`, err);
        }
    }
}

// Function to handle ICE candidates
async function handleIceCandidate(peerId, candidate) {
    const peerConnection = peers[peerId];
    const state = peerStates[peerId];
    if (peerConnection) {
        try {
            if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
                await peerConnection.addIceCandidate(candidate);
                console.log(`Added ICE candidate for peer ${peerId}`);
            } else {
                // Buffer the candidate
                state.pendingCandidates.push(candidate);
                console.log(`Buffered ICE candidate for peer ${peerId}`);
            }
        } catch (err) {
            console.error(`Error adding ICE candidate for peer ${peerId}:`, err);
        }
    } else {
        console.warn(`PeerConnection not found for peer ${peerId}`);
    }
}
// Function to attach a remote stream to a video element
function attachRemoteStream(peerId, stream) {
    let remoteVideoWrapper = remoteVideoContainers[peerId];
    if (!remoteVideoWrapper) {
        remoteVideoWrapper = document.createElement('div');
        remoteVideoWrapper.classList.add('video-wrapper');

        const videoHeader = document.createElement('h2');
        videoHeader.textContent = `Participant ${peerId}`;
        remoteVideoWrapper.appendChild(videoHeader);

        const videoElement = document.createElement('video');
        videoElement.id = `remoteVideo_${peerId}`;
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        remoteVideoWrapper.appendChild(videoElement);

        document.getElementById('remoteVideos').appendChild(remoteVideoWrapper);

        // Store the wrapper div instead of the video element
        remoteVideoContainers[peerId] = remoteVideoWrapper;
    }
    const videoElement = remoteVideoWrapper.querySelector('video');
    videoElement.srcObject = stream;
}

// Function to send MQTT message
function sendMqttMessage(payload, recipientId = null, callback = () => {}) {
    const meetingId = document.getElementById('meetingId').value;
    const mqttTopic = mqttTopicPrefix + meetingId;
    payload.sender = localId;
    payload.recipient = recipientId; // Null means broadcast to all

    mqttClient.publish(mqttTopic, JSON.stringify(payload), {}, (err) => {
        if (err) {
            console.error('Failed to send message:', err);
        } else {
            console.log('Sent message:', payload);
        }
        callback(); // Ensure the callback is called after attempting to send the message
    });
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
        if (payload.type === 'ping') {
            // Update peer activity timestamp
            peerActivity[senderId] = Date.now();
            console.log(`Received ping from peer ${senderId}`);
            return; // No further processing needed for ping messages
        }
    
        // Update peer activity timestamp for other message types
        peerActivity[senderId] = Date.now();
    
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

    setInterval(sendPingToPeers, 5000); // Every 5 seconds

    // Handle page unload to send "leave" message
    window.addEventListener('beforeunload', () => {
        sendMqttMessage({ type: 'leave' });
        closeAllConnections();
    });
}

// Function to set up local media (camera and microphone)
async function setupLocalMedia() {
    const enableVideo = document.getElementById('enableVideo').checked;
    const enableAudio = document.getElementById('enableAudio').checked;

    try {
        if (enableVideo || enableAudio) {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: enableVideo,
                audio: enableAudio
            });
        } else {
            // Create an empty stream if no media is enabled
            localStream = new MediaStream();
        }

        // Set up local video display
        const localVideo = document.getElementById('localVideo');
        if (enableVideo) {
            localVideo.srcObject = localStream;
            localVideo.style.display = 'block';
        } else {
            localVideo.srcObject = null;
            localVideo.style.display = 'none';
        }

        console.log('Local media set up with video:', enableVideo, 'audio:', enableAudio);
    } catch (err) {
        console.error('Error accessing local media:', err);
        alert('Could not access camera or microphone. Please check permissions.');

        // Create an empty stream if access is denied
        localStream = new MediaStream();
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

    // Remove the video wrapper from the DOM
    if (remoteVideoContainers[peerId]) {
        const videoWrapper = remoteVideoContainers[peerId];
        if (videoWrapper) {
            videoWrapper.remove(); // Remove the wrapper div from the DOM
        }
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

    // Remove peer state
    if (peerStates[peerId]) {
        delete peerStates[peerId];
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
function sendPingToPeers() {
    for (const peerId in peers) {
        sendMqttMessage({ type: 'ping' }, peerId);
        console.log(`Sent ping to peer ${peerId}`);
    }
}
// Function to close all connections when leaving the conference
function closeAllConnections() {
    for (const peerId in peers) {
        if (peers[peerId]) {
            peers[peerId].close();
            delete peers[peerId];

        }
    }
}
async function handleMediaToggle() {
    const enableVideo = document.getElementById('enableVideo').checked;
    const enableAudio = document.getElementById('enableAudio').checked;

    try {
        // Get the new media stream based on updated settings
        let newStream;
        if (enableVideo || enableAudio) {
            newStream = await navigator.mediaDevices.getUserMedia({
                video: enableVideo,
                audio: enableAudio
            });
        } else {
            newStream = new MediaStream();
        }

        // Update localStream reference
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        localStream = newStream;

        // Update audio tracks in peer connections
        updatePeerConnections(newStream);

        // If not screen sharing, update video track
        if (!isScreenSharing) {
            if (enableVideo) {
                updateLocalVideo(localStream);
                replaceVideoTrack(localStream.getVideoTracks()[0]);
            } else {
                updateLocalVideo(null);
                stopSendingVideoTrack();
            }
        }

        console.log('Media toggled. Video:', enableVideo, 'Audio:', enableAudio);
    } catch (err) {
        console.error('Error toggling media:', err);
        alert('Could not access camera or microphone. Please check permissions.');
    }
}


// Function to update tracks in all peer connections
function updatePeerConnections(newStream) {
    for (const peerId in peers) {
        const peerConnection = peers[peerId];
        const state = peerStates[peerId];

        // Get the senders for audio and video tracks
        const senders = peerConnection.getSenders();

        let renegotiationNeeded = false;

        // Replace or remove video track
        const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
        const newVideoTrack = newStream.getVideoTracks()[0];

        if (videoSender && newVideoTrack) {
            videoSender.replaceTrack(newVideoTrack);
            console.log(`Replaced video track for peer ${peerId}`);
        } else if (videoSender && !newVideoTrack) {
            peerConnection.removeTrack(videoSender);
            console.log(`Removed video track for peer ${peerId}`);
            renegotiationNeeded = true;
        } else if (!videoSender && newVideoTrack) {
            peerConnection.addTrack(newVideoTrack, newStream);
            console.log(`Added video track for peer ${peerId}`);
            renegotiationNeeded = true;
        }

        // Replace or remove audio track
        const audioSender = senders.find(sender => sender.track && sender.track.kind === 'audio');
        const newAudioTrack = newStream.getAudioTracks()[0];

        if (audioSender && newAudioTrack) {
            audioSender.replaceTrack(newAudioTrack);
            console.log(`Replaced audio track for peer ${peerId}`);
        } else if (audioSender && !newAudioTrack) {
            peerConnection.removeTrack(audioSender);
            console.log(`Removed audio track for peer ${peerId}`);
            renegotiationNeeded = true;
        } else if (!audioSender && newAudioTrack) {
            peerConnection.addTrack(newAudioTrack, newStream);
            console.log(`Added audio track for peer ${peerId}`);
            renegotiationNeeded = true;
        }

        // Initiate renegotiation if needed
        if (renegotiationNeeded && peerConnection.signalingState === 'stable' && !state.makingOffer) {
            console.log(`Initiating renegotiation with peer ${peerId} due to track changes`);
            renegotiate(peerId);
        }
    }
}
function leaveConference() {
    // Send a "leave" message to other participants
    sendMqttMessage({ type: 'leave' }, null, () => {
        console.log('Leave message sent to other participants.');

        // Close all RTCPeerConnections
        closeAllConnections();

        // Unsubscribe from MQTT topic and disconnect
        const meetingId = document.getElementById('meetingId').value;
        const mqttTopic = mqttTopicPrefix + meetingId;

        mqttClient.unsubscribe(mqttTopic, (err) => {
            if (err) {
                console.error('Error unsubscribing from MQTT topic:', err);
            } else {
                console.log('Unsubscribed from MQTT topic');
            }

            mqttClient.end(false, () => {
                console.log('MQTT client disconnected');

                // Clear remote videos
                for (const peerId in remoteVideoContainers) {
                    const videoWrapper = remoteVideoContainers[peerId];
                    if (videoWrapper && videoWrapper.parentElement) {
                        videoWrapper.parentElement.removeChild(videoWrapper);
                    }
                    delete remoteVideoContainers[peerId];
                }

                // Stop local media stream
                if (localStream) {
                    localStream.getTracks().forEach(track => track.stop());
                    localStream = null;
                }

                // Reset local video element
                const localVideo = document.getElementById('localVideo');
                localVideo.srcObject = null;
                localVideo.style.display = 'none';

                // Clear data structures
                peers = {};
                peerStates = {};
                peerStreams = {};
                peerActivity = {};

                console.log('Left the conference');
            });
        });
    });
}
let isScreenSharing = false;
let screenStream;
function replaceVideoTrack(newTrack) {
    for (const peerId in peers) {
        const peerConnection = peers[peerId];
        const state = peerStates[peerId];

        // Get the sender for the video track
        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');

        if (sender) {
            sender.replaceTrack(newTrack).then(() => {
                console.log(`Replaced video track for peer ${peerId}`);

                // Initiate renegotiation if the signaling state is stable
                if (peerConnection.signalingState === 'stable' && !state.makingOffer) {
                    renegotiate(peerId);
                }
            }).catch(error => {
                console.error(`Error replacing video track for peer ${peerId}:`, error);
            });
        } else {
            // If there is no video sender, add the new track
            peerConnection.addTrack(newTrack, new MediaStream([newTrack]));

            // Initiate renegotiation
            if (peerConnection.signalingState === 'stable' && !state.makingOffer) {
                renegotiate(peerId);
            }
        }
    }
}
function renegotiate(peerId) {
    const peerConnection = peers[peerId];
    const state = peerStates[peerId];

    if (state.makingOffer) {
        console.log(`Already making an offer to peer ${peerId}, skipping renegotiation`);
        return;
    }

    state.makingOffer = true;

    peerConnection.createOffer().then(offer => {
        return peerConnection.setLocalDescription(offer);
    }).then(() => {
        console.log(`Created and set local offer for peer ${peerId} during renegotiation`);
        sendMqttMessage({
            type: 'sdp',
            sdp: peerConnection.localDescription.sdp,
            sdpType: peerConnection.localDescription.type
        }, peerId);
    }).catch(err => {
        console.error(`Error during renegotiation with peer ${peerId}:`, err);
    }).finally(() => {
        state.makingOffer = false;
    });
}

function updateLocalVideo(stream) {
    const localVideo = document.getElementById('localVideo');
    if (stream) {
        localVideo.srcObject = stream;
        localVideo.style.display = 'block';
    } else {
        localVideo.srcObject = null;
        localVideo.style.display = 'none';
    }
}
function stopSendingVideoTrack() {
    for (const peerId in peers) {
        const peerConnection = peers[peerId];

        // Get the sender for the video track
        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');

        if (sender) {
            peerConnection.removeTrack(sender);
        }
    }
}
async function handleScreenShareToggle() {
    if (!isScreenSharing) {
        // Start screen sharing
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            isScreenSharing = true;
            document.getElementById('screenShareButton').textContent = 'Stop Screen Share';
            updateLocalVideo(screenStream);
            replaceVideoTrack(screenStream.getVideoTracks()[0]);
            console.log('Screen sharing started.');
            
            // Handle the event when the user stops screen sharing using browser UI
            screenStream.getVideoTracks()[0].addEventListener('ended', () => {
                console.log('Screen sharing stopped by user.');
                handleScreenShareToggle(); // Stop screen sharing
            });
        } catch (err) {
            console.error('Error starting screen sharing:', err);
            alert('Failed to start screen sharing.');
        }
    } else {
        // Stop screen sharing
        isScreenSharing = false;
        document.getElementById('screenShareButton').textContent = 'Start Screen Share';

        // Revert to the camera stream if available
        if (localStream && localStream.getVideoTracks().length > 0) {
            updateLocalVideo(localStream);
            replaceVideoTrack(localStream.getVideoTracks()[0]);
            console.log('Reverted to camera stream.');
        } else {
            // No camera stream available
            stopSendingVideoTrack();
            updateLocalVideo(null);
            console.log('No camera stream available.');
        }

        // Stop the screen stream
        if (screenStream) {
            screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;
        }
    }
}

document.getElementById('enableVideo').addEventListener('change', handleMediaToggle);
document.getElementById('enableAudio').addEventListener('change', handleMediaToggle);
document.getElementById('screenShareButton').addEventListener('click', handleScreenShareToggle);

// Add event listener to the Join Conference button
document.getElementById('joinButton').addEventListener('click', async () => {
    await joinConference();
    document.getElementById('joinButton').disabled = true;
    document.getElementById('leaveButton').disabled = false;
    document.getElementById('screenShareButton').disabled = false;
});

// Add event listener to the Leave Conference button
document.getElementById('leaveButton').addEventListener('click', () => {
    leaveConference();
    document.getElementById('joinButton').disabled = false;
    document.getElementById('leaveButton').disabled = true;
    document.getElementById('screenShareButton').disabled = true;

});
// Define the MQTT broker URL and topic prefix
const mqttBroker = 'wss://mqtt-dashboard.com:8884/mqtt'; // Replace with your MQTT broker URL
const mqttTopicPrefix = 'webrtc/';
