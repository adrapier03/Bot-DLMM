import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegram(message, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }, { timeout: 10000 });
      return; // sukses, keluar
    } catch (err) {
      const detail = err.response?.data?.description || err.message || 'unknown error';
      console.error(`[Telegram] Failed to send (attempt ${i + 1}/${retries}): ${detail}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
}
