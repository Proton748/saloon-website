// ─────────────────────────────────────────────
//  Sharma's Royal Salon — Backend Server
//  Stack: Node.js + Express + MongoDB + Telegram
// ─────────────────────────────────────────────

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
require('dotenv').config();

const app = express();

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json());

// ── MONGODB CONNECTION ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── BOOKING SCHEMA ──
const bookingSchema = new mongoose.Schema({
  bookingId : { type: String, required: true, unique: true },
  name      : { type: String, required: true },
  phone     : { type: String, required: true },
  service   : { type: String, required: true },
  date      : { type: String, required: true },
  slot      : { type: String, required: true },
  status    : { type: String, default: 'confirmed' },
  createdAt : { type: Date, default: Date.now }
});

const Booking = mongoose.model('Booking', bookingSchema);

// ─────────────────────────────────────────────
//  TELEGRAM HELPER
//  Sends a message to the salon owner's Telegram
//  Uses simple fetch — no SDK needed at all
// ─────────────────────────────────────────────
async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // Skip silently if not configured
  if (!token || !chatId) {
    console.log('⚠️  Telegram not configured — skipping notification');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        chat_id    : chatId,
        text       : message,
        parse_mode : 'HTML'  // allows <b>bold</b> in messages
      })
    });

    const data = await res.json();
    if (data.ok) {
      console.log('📲 Telegram notification sent!');
    } else {
      console.error('Telegram error:', data.description);
    }
  } catch (err) {
    // Don't crash the app if Telegram fails
    console.error('Telegram send failed:', err.message);
  }
}

// ─────────────────────────────────────────────
//  ROUTE 1: GET /api/slots/:date
//  Returns all booked slots for a given date
// ─────────────────────────────────────────────
app.get('/api/slots/:date', async (req, res) => {
  try {
    const bookings = await Booking.find({
      date   : req.params.date,
      status : 'confirmed'
    }).select('slot -_id');

    const bookedSlots = bookings.map(b => b.slot);
    res.json({ bookedSlots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch slots. Try again.' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 2: POST /api/book
//  Creates booking, saves to MongoDB,
//  sends Telegram notification to owner
// ─────────────────────────────────────────────
app.post('/api/book', async (req, res) => {
  try {
    const { name, phone, service, date, slot } = req.body;

    // ── Validation ──
    if (!name || !phone || !service || !date || !slot) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
    }

    // ── Check slot not already taken ──
    const existing = await Booking.findOne({ date, slot, status: 'confirmed' });
    if (existing) {
      return res.status(409).json({ error: 'This slot just got booked. Please pick another time.' });
    }

    // ── Generate Booking ID ──
    const bookingId = 'SRS-' + Date.now().toString(36).toUpperCase().slice(-6);

    // ── Save to MongoDB ──
    const booking = new Booking({ bookingId, name, phone, service, date, slot });
    await booking.save();

    // ── Send Telegram to Owner ──
    const message =
      `🔔 <b>New Booking Alert!</b>\n\n` +
      `📋 ID: <b>${bookingId}</b>\n` +
      `👤 Name: ${name}\n` +
      `📞 Phone: <b>${phone}</b>\n` +
      `✂️ Service: ${service}\n` +
      `📅 Date: ${date}\n` +
      `⏰ Slot: <b>${slot}</b>\n\n` +
      `<i>Sharma's Royal Salon — Siwan</i>`;

    await sendTelegram(message);

    // ── Respond to frontend ──
    res.json({
      success   : true,
      bookingId,
      message   : 'Booking confirmed!'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 3: GET /api/queue
//  Live queue count for today
// ─────────────────────────────────────────────
app.get('/api/queue', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const count = await Booking.countDocuments({ date: today, status: 'confirmed' });
    res.json({ waiting: count, estimatedWaitMins: count * 20 });
  } catch (err) {
    res.status(500).json({ waiting: 0, estimatedWaitMins: 0 });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 4: GET /api/bookings?date=YYYY-MM-DD
//  See all bookings for a date (owner use)
// ─────────────────────────────────────────────
app.get('/api/bookings', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const bookings = await Booking.find({ date }).sort({ slot: 1 });
    res.json({ date, count: bookings.length, bookings });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch bookings.' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 5: DELETE /api/cancel/:bookingId
// ─────────────────────────────────────────────
app.delete('/api/cancel/:bookingId', async (req, res) => {
  try {
    const booking = await Booking.findOneAndUpdate(
      { bookingId: req.params.bookingId },
      { status: 'cancelled' },
      { new: true }
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    await sendTelegram(`❌ <b>Booking Cancelled</b>\nID: ${req.params.bookingId}`);
    res.json({ success: true, message: 'Booking cancelled.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not cancel booking.' });
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: "Sharma's Royal Salon API", time: new Date() });
});

// ── START ──
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
});
