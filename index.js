const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const userMessage = event.message.text;
    const replyToken = event.replyToken;
    const keywords = ['สรุป', 'ยอด', 'ค่าใช้จ่าย', 'รายจ่าย', 'summary'];
    if (!keywords.some(k => userMessage.includes(k))) continue;
    try {
      const geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
        { contents: [{ parts: [{ text: `คุณเป็นผู้ช่วยสรุปค่าใช้จ่ายของทีมงาน สรุปให้ชัดเจน แสดงเป็นหมวดหมู่ รวมยอด และบอกว่าหมวดไหนใช้มากสุด ตอบเป็นภาษาไทย ใช้ emoji ให้อ่านง่าย\n\nข้อมูล: ${userMessage}` }] }] }
      );
      const reply = geminiRes.data.candidates[0].content.parts[0].text;
      await axios.post(
        'https://api.line.me/v2/bot/message/reply',
        { replyToken, messages: [{ type: 'text', text: reply }] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
      );
    } catch (err) {
      console.error(err.response?.data || err.message);
    }
  }
});

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000);
