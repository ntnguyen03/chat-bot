const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nam123455A";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "EAAJqARd2GIMBO61AGNPNsRTHJkMBjdoZCqpy5EbtLdGhsC96rFkhXTxfZB9sQRud3VRqF1s65P4X23X1cZB116MVRGeGYJdYD107PUwCZCtkNZAddNMHIOA1DyG1672o9n0j7ffMvxHw85x5sPBWLLAv7uCKeJXoeTcGFJhGlAMH5xj4KxOiLq0ENfg1UhJysLHwZBQEyZC3SKkkL0p7QZDZD";

app.use(bodyParser.json());

// Xác minh Webhook với Facebook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verified!");
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Xử lý tin nhắn từ người dùng
app.post('/webhook', (req, res) => {
    const data = req.body;

    if (data.object === 'page') {
        data.entry.forEach(entry => {
            entry.messaging.forEach(event => {
                if (event.message) {
                    handleMessage(event.sender.id, event.message.text);
                }
            });
        });
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

function sendMessage(senderId, text) {
    axios.post(`https://graph.facebook.com/v13.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        recipient: { id: senderId },
        message: { text: text }
    })
    .then(response => console.log("📩 Message sent!"))
    .catch(error => console.error("❌ Error sending message:", error));
}

function handleMessage(senderId, message) {
    if (message.toLowerCase().includes("hello")) {
        sendMessage(senderId, "👋 Chào bạn! Tôi có thể giúp gì?");
    } else {
        sendMessage(senderId, "🤖 Tôi chưa hiểu yêu cầu của bạn!");
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Server chạy trên cổng ${PORT}`);
});
