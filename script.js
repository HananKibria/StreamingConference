// script.js

let mqttClient;
let localId;
let peers = {}; // Holds RTCPeerConnections keyed by peer ID
let peerStates = {}; // Holds negotiation flags and transceivers per peer
let peerStreams = {}; // Holds MediaStreams from each peer
let remoteVideoContainers = {}; // Holds video elements for each peer
let localStream; // Global variable for local media stream
let peerActivity = {}; // Tracks the last activity time of peers
let isLocalMediaReady = false; // Flag to indicate local media readiness

let isRecording = false;
let mediaRecorder;
let recordedBlobs = [];
let canvasStream;
let mixedAudioStream;
let combinedStream;
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

    // Initialize peerStates for this peer if not already done
    if (!peerStates[peerId]) {
        peerStates[peerId] = {};
    }

    // Add transceivers for audio and video
    const videoTransceiver = peerConnection.addTransceiver('video', { direction: 'sendrecv' });
    const audioTransceiver = peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
    peerStates[peerId].videoTransceiver = videoTransceiver;
    peerStates[peerId].audioTransceiver = audioTransceiver;

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

        event.track.addEventListener('mute', () => {
            console.log(`Track muted from peer ${peerId}:`, event.track.kind);
            // Optional: Display a placeholder or black screen
        });

        event.track.addEventListener('unmute', () => {
            console.log(`Track unmuted from peer ${peerId}:`, event.track.kind);
            // Optional: Update the UI if necessary
        });
    };

    // Handle negotiation needed
    peerConnection.onnegotiationneeded = async () => {
        const state = peerStates[peerId];
        try {
            if (state.makingOffer) return;
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

    if (!localStream) {
        console.warn(`Local media not ready when initiating connection with peer ${peerId}`);
        return;
    }

    console.log(`Initiating connection with peer ${peerId}`);

    // Initialize peer negotiation state
    peerStates[peerId] = {
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        polite: parseInt(localId) < parseInt(peerId), // The peer with the lower ID is polite
        pendingCandidates: []
    };

    // Create a new RTCPeerConnection for this peer
    const peerConnection = createPeerConnection(peerId);
    peers[peerId] = peerConnection;

    // Add local tracks to the transceivers
    let currentVideoTrack;
    if (isScreenSharing && screenStream && screenStream.getVideoTracks().length > 0) {
        currentVideoTrack = screenStream.getVideoTracks()[0];
    } else if (localStream && localStream.getVideoTracks().length > 0) {
        currentVideoTrack = localStream.getVideoTracks()[0];
    }

    if (currentVideoTrack) {
        peerStates[peerId].videoTransceiver.sender.replaceTrack(currentVideoTrack);
        peerStates[peerId].videoTransceiver.direction = 'sendrecv';
    } else {
        // If there's no video track, replace with null and set direction to 'recvonly'
        peerStates[peerId].videoTransceiver.sender.replaceTrack(null);
        peerStates[peerId].videoTransceiver.direction = 'recvonly';
    }

    // Add audio track if available
    if (localStream && localStream.getAudioTracks().length > 0) {
        const audioTrack = localStream.getAudioTracks()[0];
        peerStates[peerId].audioTransceiver.sender.replaceTrack(audioTrack);
        peerStates[peerId].audioTransceiver.direction = 'sendrecv';
    } else {
        // If there's no audio track, replace with null and set direction to 'recvonly'
        peerStates[peerId].audioTransceiver.sender.replaceTrack(null);
        peerStates[peerId].audioTransceiver.direction = 'recvonly';
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
    if (!localStream) {
        console.warn(`Local media not ready when handling SDP message from peer ${peerId}`);
        await setupLocalMedia();
    }
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
    await setupLocalMedia(); // Ensure localStream is ready

    mqttClient = mqtt.connect(mqttBroker);
    const meetingId = document.getElementById('meetingId').value;
    const mqttTopic = mqttTopicPrefix + meetingId;

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT broker');
        mqttClient.subscribe(mqttTopic);

        // Announce presence to other peers
        sendMqttMessage({ type: 'new-peer' });
    });

    mqttClient.on('message', async (topic, message) => {
        if (!isLocalMediaReady) {
            console.log('Local media not ready, delaying message processing');
            await new Promise(resolve => {
                const checkInterval = setInterval(() => {
                    if (isLocalMediaReady) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
            });
        }

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

    // Start monitoring peer activity
    setInterval(checkPeerActivity, 10000); // Check every 10 seconds
    setInterval(sendPingToPeers, 5000); // Every 5 seconds

    // Handle page unload to send "leave" message
    window.addEventListener('beforeunload', () => {
        sendMqttMessage({ type: 'leave' });
        if (isRecording) {
            stopRecording();
        }
        closeAllConnections();
    });
}

// Function to set up local media (camera and microphone)
async function setupLocalMedia() {
    const enableVideo = true;
    const enableAudio = true;

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
    } finally {
        isLocalMediaReady = true;
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

// Function to renegotiate the peer connection
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

        // Update tracks in peer connections
        updatePeerConnections(newStream);

        // Update local video display
        if (!isScreenSharing) {
            if (enableVideo) {
                updateLocalVideo(localStream);
            } else {
                updateLocalVideo(null);
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

        let renegotiationNeeded = false;

        // Update video track
        const newVideoTrack = newStream.getVideoTracks()[0] || null;
        if (state.videoTransceiver) {
            state.videoTransceiver.sender.replaceTrack(newVideoTrack).then(() => {
                console.log(`Replaced video track for peer ${peerId}`);
            }).catch(error => {
                console.error(`Error replacing video track for peer ${peerId}:`, error);
            });

            // Set transceiver direction
            if (newVideoTrack) {
                state.videoTransceiver.direction = 'sendrecv';
            } else {
                state.videoTransceiver.direction = 'recvonly';
            }

            renegotiationNeeded = true;
        } else {
            console.warn(`No video transceiver for peer ${peerId}`);
        }

        // Update audio track
        const newAudioTrack = newStream.getAudioTracks()[0] || null;
        if (state.audioTransceiver) {
            state.audioTransceiver.sender.replaceTrack(newAudioTrack).then(() => {
                console.log(`Replaced audio track for peer ${peerId}`);
            }).catch(error => {
                console.error(`Error replacing audio track for peer ${peerId}:`, error);
            });

            // Set transceiver direction
            if (newAudioTrack) {
                state.audioTransceiver.direction = 'sendrecv';
            } else {
                state.audioTransceiver.direction = 'recvonly';
            }

            renegotiationNeeded = true;
        } else {
            console.warn(`No audio transceiver for peer ${peerId}`);
        }

        // Renegotiate if needed
        if (renegotiationNeeded && peerConnection.signalingState === 'stable' && !state.makingOffer) {
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
    document.getElementById('joinButton').disabled = false;
    document.getElementById('leaveButton').disabled = true;
    document.getElementById('screenShareButton').disabled = true;
    document.getElementById('leaveCallButton').disabled = true;
    if (isRecording) {
        stopRecording();
    }
}

let isScreenSharing = false;
let screenStream;

function replaceVideoTrack(newTrack) {
    for (const peerId in peers) {
        const state = peerStates[peerId];
        const peerConnection = peers[peerId];

        if (state.videoTransceiver) {
            state.videoTransceiver.sender.replaceTrack(newTrack).then(() => {
                console.log(`Replaced video track for peer ${peerId}`);

                // Set transceiver direction
                if (newTrack) {
                    state.videoTransceiver.direction = 'sendrecv';
                } else {
                    state.videoTransceiver.direction = 'recvonly';
                }

                // Renegotiate if needed
                if (peerConnection.signalingState === 'stable' && !state.makingOffer) {
                    renegotiate(peerId);
                }
            }).catch(error => {
                console.error(`Error replacing video track for peer ${peerId}:`, error);
            });
        } else {
            console.warn(`No video transceiver for peer ${peerId}`);
        }
    }
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

async function handleScreenShareToggle() {
    const screenShareButton = document.getElementById('screenShareButton');
    if (!isScreenSharing) {
        // Start screen sharing
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            isScreenSharing = true;
            // Change the icon to indicate screen sharing is active
            screenShareButton.innerHTML = '<i class="fas fa-stop-circle"></i>';
            screenShareButton.title = 'Stop Screen Share';

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
        // Revert the icon back to the original
        screenShareButton.innerHTML = '<i class="fas fa-desktop"></i>';
        screenShareButton.title = 'Start Screen Share';

        // Revert to the camera stream if available
        if (localStream && localStream.getVideoTracks().length > 0) {
            updateLocalVideo(localStream);
            replaceVideoTrack(localStream.getVideoTracks()[0]);
            console.log('Reverted to camera stream.');
        } else {
            // No camera stream available
            replaceVideoTrack(null);
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
function handleVideoToggle() {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        // Update the icon
        const videoButton = document.getElementById('toggleVideo');
        videoButton.innerHTML = videoTrack.enabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
    }
}

function handleAudioToggle() {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        // Update the icon
        const audioButton = document.getElementById('toggleAudio');
        audioButton.innerHTML = audioTrack.enabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
    }
}

document.getElementById('toggleVideo').addEventListener('click', handleVideoToggle);
document.getElementById('toggleAudio').addEventListener('click', handleAudioToggle);
document.getElementById('screenShareButton').addEventListener('click', handleScreenShareToggle);
document.getElementById('joinButton').addEventListener('click', async () => {
    await joinConference();
    document.getElementById('joinButton').disabled = true;
    document.getElementById('leaveButton').disabled = false;
    document.getElementById('screenShareButton').disabled = false;
    document.getElementById('leaveCallButton').disabled = false;
});
document.getElementById('leaveButton').addEventListener('click', leaveConference);
document.getElementById('leaveCallButton').addEventListener('click', leaveConference);
// document.getElementById('enableVideo').addEventListener('change', handleMediaToggle);
// document.getElementById('enableAudio').addEventListener('change', handleMediaToggle);
// document.getElementById('screenShareButton').addEventListener('click', handleScreenShareToggle);

// // Add event listener to the Join Conference button
// document.getElementById('joinButton').addEventListener('click', async () => {
//     await joinConference();
//     document.getElementById('joinButton').disabled = true;
//     document.getElementById('leaveButton').disabled = false;
//     document.getElementById('screenShareButton').disabled = false;
// });

// // Add event listener to the Leave Conference button
// document.getElementById('leaveButton').addEventListener('click', () => {
//     leaveConference();
//     document.getElementById('joinButton').disabled = false;
//     document.getElementById('leaveButton').disabled = true;
//     document.getElementById('screenShareButton').disabled = true;
// });

// Define the MQTT broker URL and topic prefix
const mqttBroker = 'wss://mqtt-dashboard.com:8884/mqtt'; // Replace with your MQTT broker URL
const mqttTopicPrefix = 'webrtc/';
//let angle = 0;

// function drawCanvas() {
//     ctx.clearRect(0, 0, canvas.width, canvas.height);

//     // Existing code to draw videos...

//     // Draw a small rotating rectangle to force canvas updates
//     ctx.save();
//     ctx.translate(canvas.width - 50, canvas.height - 50);
//     ctx.rotate(angle);
//     ctx.fillStyle = 'red';
//     ctx.fillRect(-10, -10, 20, 20);
//     ctx.restore();

//     angle += 0.1; // Update angle to animate

//     if (isRecording) {
//         requestAnimationFrame(drawCanvas);
//     }
//     const drawInterval = setInterval(drawCanvas, 33); // Approximately 30 FPS

// // When stopping recording
//     if (!isRecording) {
//          clearInterval(drawInterval);
//     }
// }

function startRecording() {
    if (isRecording) return;

    console.log('Initializing recording...');

    // Create canvas and context
    const canvas = document.getElementById('recordingCanvas');
    if (!canvas) {
        console.error('Canvas element not found.');
        return;
    }
    const ctx = canvas.getContext('2d');

    // Get video elements (local and remote)
    const videoElements = [document.getElementById('localVideo')];
    for (const peerId in remoteVideoContainers) {
        const videoWrapper = remoteVideoContainers[peerId];
        const videoElement = videoWrapper.querySelector('video');
        videoElements.push(videoElement);
    }

    // Ensure video elements are playing
    videoElements.forEach(video => {
        if (video.paused || video.readyState <= 2) {
            video.play().catch(error => {
                console.error('Error playing video element:', error);
            });
        }
    });

    // Adjust canvas size based on number of videos
    adjustCanvasSize(canvas, videoElements.length);

    // Initialize variables for animation
    let angle = 0;

    // Set up drawing loop
    function drawCanvas() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Calculate positions for videos (e.g., grid layout)
        const cols = Math.ceil(Math.sqrt(videoElements.length));
        const rows = Math.ceil(videoElements.length / cols);
        const videoWidth = canvas.width / cols;
        const videoHeight = canvas.height / rows;

        videoElements.forEach((video, index) => {
            const x = (index % cols) * videoWidth;
            const y = Math.floor(index / cols) * videoHeight;
            ctx.drawImage(video, x, y, videoWidth, videoHeight);
        });

        // Add a small rotating rectangle to force canvas updates
        ctx.save();
        ctx.translate(canvas.width - 50, canvas.height - 50);
        ctx.rotate(angle);
        ctx.fillStyle = 'red';
        ctx.fillRect(-10, -10, 20, 20);
        ctx.restore();

        angle += 0.1; // Update angle to animate

        // Continue the loop
        if (isRecording) {
            requestAnimationFrame(drawCanvas);
        }
    }

    // Start the drawing loop
    requestAnimationFrame(drawCanvas);

    // Capture canvas stream
    canvasStream = canvas.captureStream(30); // 30 FPS

    // For testing, use only the canvasStream
    combinedStream = canvasStream;

    // Check combined stream tracks
    console.log('Combined Stream Tracks:', combinedStream.getTracks());
    combinedStream.getTracks().forEach(track => {
        console.log(`${track.kind} track - enabled: ${track.enabled}, readyState: ${track.readyState}`);
    });

    // Initialize MediaRecorder
    let options = { mimeType: 'video/webm; codecs=vp9' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/webm; codecs=vp8' };
    }
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/webm' };
    }
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = '';
    }
    console.log('Using MediaRecorder options:', options);
    try {
        mediaRecorder = new MediaRecorder(combinedStream, options);
    } catch (e) {
        console.error('Exception while creating MediaRecorder:', e);
        alert('MediaRecorder is not supported by this browser.');
        return;
    }

    // Add event listeners for debugging
    mediaRecorder.ondataavailable = handleDataAvailable;
    mediaRecorder.onstart = () => {
        console.log('MediaRecorder started');
    };
    mediaRecorder.onstop = () => {
        console.log('MediaRecorder stopped');
    };
    mediaRecorder.onerror = function (event) {
        console.error('MediaRecorder error:', event.error);
    };
    mediaRecorder.onwarning = (e) => {
        console.warn('MediaRecorder warning:', e);
    };

    // Start recording with timeslice of 5000ms
    try {
        mediaRecorder.start(5000); // Collect data in chunks of 5 seconds
        console.log('MediaRecorder state after start:', mediaRecorder.state);
        isRecording = true;
        console.log('Recording started');
    } catch (e) {
        console.error('Error starting MediaRecorder:', e);
        return;
    }

    // Update UI
    document.getElementById('startRecordingButton').disabled = true;
    document.getElementById('stopRecordingButton').disabled = false;
}

function stopRecording() {
    if (!isRecording) return;

    mediaRecorder.stop();
    isRecording = false;
    console.log('Recording stopped');

    // Update UI
    document.getElementById('startRecordingButton').disabled = false;
    document.getElementById('stopRecordingButton').disabled = true;

    // Create a ZIP file of recorded segments
    if (window.recordingSegments && window.recordingSegments.length > 0) {
        const zip = new JSZip();
        window.recordingSegments.forEach(segment => {
            zip.file(segment.filename, segment.blob);
        });

        zip.generateAsync({ type: 'blob' }).then(content => {
            // Create a download link for the ZIP file
            const zipFilename = `meeting_recording_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
            const url = window.URL.createObjectURL(content);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = zipFilename;
            document.body.appendChild(a);
            a.click();

            // Clean up
            setTimeout(() => {
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            }, 100);

            // Reset the recorded segments
            window.recordingSegments = [];
        });
    }
}

function handleDataAvailable(event) {
    if (event.data && event.data.size > 0) {
        // Create a timestamped filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `meeting_recording_${timestamp}.webm`;

        // Store the filename and blob
        if (!window.recordingSegments) {
            window.recordingSegments = [];
        }
        window.recordingSegments.push({ filename, blob: event.data });
    }
}

function getMixedAudioStream() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const destination = audioContext.createMediaStreamDestination();

    // Add local audio tracks
    if (localStream && localStream.getAudioTracks().length > 0) {
        const source = audioContext.createMediaStreamSource(new MediaStream([localStream.getAudioTracks()[0]]));
        source.connect(destination);
    }

    // Add remote audio tracks
    for (const peerId in peerStreams) {
        const remoteStream = peerStreams[peerId];
        if (remoteStream && remoteStream.getAudioTracks().length > 0) {
            const source = audioContext.createMediaStreamSource(new MediaStream([remoteStream.getAudioTracks()[0]]));
            source.connect(destination);
        }
    }

    return destination.stream;
}

function updateRecordingStreams() {
    if (!isRecording) return;

    // Stop current recording
    mediaRecorder.stop();
    isRecording = false;

    // Restart recording
    startRecording();
}

function adjustCanvasSize(canvas, videoCount) {
    // Adjust canvas size based on the number of video elements
    // For simplicity, we keep it fixed at 1280x720
    canvas.width = 1280;
    canvas.height = 720;
}

// Add event listeners for recording buttons
document.getElementById('startRecordingButton').addEventListener('click', () => {
    startRecording();
});

document.getElementById('stopRecordingButton').addEventListener('click', () => {
    stopRecording();
});
