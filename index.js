const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const SHEETS_ID = process.env.SHEETS_ID;
const GROUP_ID = process.env.GROUP_ID;
const GOOGLE_CREDS = JSON.parse(process.env.GOOGLE_CREDS);

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function appendToSheet(date, amount, description, category) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: 'Sheet1!A:E',
    valueInputOption: 'RAW',
    resource: { values: [[date, amount, description, category, 'slip']] },
  });
}

async function getMonthlyData() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: 'Sheet1!A:E',
  });
  return res.data.values || [];
}

async function sendLineMessage(to, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
  );
}

// สรุปอัตโนมัติทุกสิ้นเดือน (วันสุดท้ายของเดือน เวลา 20:00)
cron.schedule('0 20 28-31 * *', async () => {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (now.getDate() !== lastDay) return;

  const rows = await getMonthlyData();
  const month = now.toLocaleString('th-TH', { month: 'long', year: 'numeric' });

  const geminiRes = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
    { contents: [{ parts: [{ text: `สรุปค่าใช้จ่ายประจำเดือน ${month} จากข้อมูลนี้:\n${JSON.stringify(rows)}\nแสดงเป็นหมวดหมู่ รวมยอดทั้งหมด และบอกว่าหมวดไหนใช้มากสุด ตอบเป็นภาษาไทย ใช้ emoji` }] }] }
  );

  const summary = geminiRes.data.candidates[0].content.parts[0].text;
  await sendLineMessage(GROUP_ID, `📊 สรุปค่าใช้จ่ายประจำเดือน ${month}\n\n${summary}`);
}, { timezone: 'Asia/Bangkok' });

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message') continue;
    const replyToken = event.replyToken;

    // อ่านสลิป (รูปภาพ)
    if (event.message.type === 'image') {
      try {
        const imgRes = await axios.get(
          `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
          { headers: { Authorization: `Bearer ${LINE_TOKEN}` }, responseType: 'arraybuffer' }
        );
        const base64 = Buffer.from(imgRes.data).toString('base64');

        const geminiRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=${GEMINI_KEY}`,
          {
            contents: [{
              parts: [
                { text: 'นี่คือสลิปการโอนเงินหรือใบเสร็จ กรุณาอ่านและระบุ: 1.ยอดเงิน 2.รายการ/หมวดหมู่ 3.วันที่ ตอบเป็น JSON format: {"amount": 0, "description": "", "category": "", "date": ""}' },
                { inline_data: { mime_type: 'image/jpeg', data: base64 } }
              ]
            }]
          }
        );

        const text = geminiRes.data.candidates[0].content.parts[0].text;
        const clean = text.replace(/```json|```/g, '').trim();
        const data = JSON.parse(clean);

        await appendToSheet(data.date || new Date().toLocaleDateString('th-TH'), data.amount, data.description, data.category);

        await axios.post(
          'https://api.line.me/v2/bot/message/reply',
          { replyToken, messages: [{ type: 'text', text: `✅ บันทึกแล้วครับ!\n💰 ยอด: ${data.amount} บาท\n📝 รายการ: ${data.description}\n🏷️ หมวด: ${data.category}\n📅 วันที่: ${data.date}` }] },
          { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
        );
      } catch (err) {
        console.error(err.response?.data || err.message);
      }
    }

    // สรุปด้วยคำสั่ง
    if (event.message.type === 'text') {
      const userMessage = event.message.text;
      const keywords = ['สรุป', 'ยอด', 'ค่าใช้จ่าย', 'รายจ่าย', 'summary'];
      if (!keywords.some(k => userMessage.includes(k))) continue;

      try {
        const rows = await getMonthlyData();
        const geminiRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
          { contents: [{ parts: [{ text: `สรุปค่าใช้จ่ายจากข้อมูลนี้:\n${JSON.stringify(rows)}\nแสดงเป็นหมวดหมู่ รวมยอด และบอกว่าหมวดไหนใช้มากสุด ตอบเป็นภาษาไทย ใช้ emoji` }] }] }
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
  }
});

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000);
