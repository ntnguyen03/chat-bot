// Import các thư viện cần thiết
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const chrono = require('chrono-node');

// Khởi tạo ứng dụng Express
const app = express();
app.use(express.json());

// Lấy các biến môi trường từ file .env
const { PAGE_ACCESS_TOKEN, VERIFY_TOKEN, MONGO_URI, PORT } = process.env;

// Kết nối MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('Kết nối MongoDB thành công'))
  .catch(err => console.error('Lỗi kết nối MongoDB:', err));

// Định nghĩa schema cho sự kiện
const EventSchema = new mongoose.Schema({
  senderId: String,
  content: String,
  time: Date,
  repeat: String, // 'daily', 'weekly', hoặc false
  participants: [String],
  status: { type: String, default: 'pending' }
});

const Event = mongoose.model('Event', EventSchema);

// Route mặc định
app.get('/', (req, res) => {
  res.send('Server đang chạy!');
});

// Route để ping
app.get('/ping', (req, res) => {
  res.status(200).send('Bot is awake!');
});

// Xác thực Webhook từ Facebook
app.get('/webhook', (req, res) => {
  console.log('Nhận yêu cầu GET từ Facebook:', req.query);
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// Hàm chuyển đổi thời gian sang múi giờ Việt Nam (GMT+7)
const toVietnamTime = (date) => {
  const vietnamOffset = 7 * 60; // GMT+7 (7 giờ = 7 * 60 phút)
  const utcDate = new Date(date);
  const vietnamTime = new Date(utcDate.getTime() + vietnamOffset * 60 * 1000);
  return vietnamTime;
};

// Hàm chuyển thời gian từ múi giờ Việt Nam về UTC
const toUTCTime = (date) => {
  const vietnamOffset = 7 * 60; // GMT+7 (7 giờ = 7 * 60 phút)
  const vietnamDate = new Date(date);
  const utcTime = new Date(vietnamDate.getTime() - vietnamOffset * 60 * 1000);
  return utcTime;
};

// Hàm định dạng thời gian theo dạng "ngày/tháng/năm giờ:phút" ở múi giờ Việt Nam
const formatDateTime = (date) => {
  const vietnamDate = toVietnamTime(date);
  const day = String(vietnamDate.getUTCDate()).padStart(2, '0');
  const month = String(vietnamDate.getUTCMonth() + 1).padStart(2, '0');
  const year = vietnamDate.getUTCFullYear();
  const hours = String(vietnamDate.getUTCHours()).padStart(2, '0');
  const minutes = String(vietnamDate.getUTCMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
};

// Hàm phân tích thời gian tiếng Việt
const parseVietnameseTime = (message) => {
  let baseDate = new Date(); // Thời gian hiện tại (UTC)
  let time = null;

  // Xác định ngày/tháng/năm
  const dateMatch = message.match(/ngày\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/i);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10) - 1; // Tháng trong JavaScript bắt đầu từ 0
    const year = dateMatch[3] ? parseInt(dateMatch[3], 10) : baseDate.getFullYear();
    baseDate = new Date(Date.UTC(year, month, day));
  } else if (message.includes('ngày mai')) {
    baseDate = toVietnamTime(baseDate); // Chuyển sang múi giờ Việt Nam để tính ngày
    baseDate.setDate(baseDate.getDate() + 1);
    baseDate = new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()));
  } else if (message.includes('hôm nay')) {
    baseDate = toVietnamTime(baseDate); // Chuyển sang múi giờ Việt Nam
    baseDate = new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()));
  }

  // Xác định giờ
  const timeMatch = message.match(/(\d{1,2})h\s*(sáng|chiều)?/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const period = timeMatch[2] ? timeMatch[2].toLowerCase() : '';

    // Điều chỉnh giờ theo buổi (sáng/chiều)
    if (period === 'chiều' && hour < 12) {
      hour += 12; // Chuyển sang giờ chiều (ví dụ: 4h chiều -> 16h)
    } else if (period === 'sáng' && hour === 12) {
      hour = 0; // 12h sáng -> 0h
    }

    // Tạo một bản sao của baseDate và đặt giờ theo múi giờ Việt Nam
    const vietnamDate = toVietnamTime(baseDate);
    vietnamDate.setHours(hour, 0, 0, 0); // Đặt giờ theo múi giờ Việt Nam
    time = toUTCTime(vietnamDate); // Chuyển về UTC để lưu vào MongoDB
  }

  return time;
};

// Hàm trích xuất nội dung từ tin nhắn
const extractContent = (message) => {
  let content = message
    .replace(/ngày\s+\d{1,2}\/\d{1,2}(?:\/\d{4})?/i, '')
    .replace(/ngày mai|hôm nay|nay/i, '')
    .replace(/lúc\s+\d{1,2}h\s*(sáng|chiều)?/i, '')
    .replace(/\d{1,2}h\s*(sáng|chiều)?/i, '')
    .replace(/mỗi ngày|mỗi tuần/i, '')
    .replace(/với\s+\w+/i, '')
    .trim();

  if (!content) {
    const words = message.split(' ');
    content = words[0];
  }

  return content;
};

// Hàm phân tích tin nhắn
const parseMessage = (message) => {
  const event = { content: '', time: null, repeat: false, participants: [], new_time: null };

  // Ưu tiên sử dụng logic thủ công cho tiếng Việt
  event.time = parseVietnameseTime(message);

  // Nếu logic thủ công không phân tích được, thử dùng chrono-node
  if (!event.time) {
    const parsedTime = chrono.parse(message);
    if (parsedTime[0]) {
      event.time = parsedTime[0].start.date();
    }
  }

  // Trích xuất thời gian mới (cho lệnh "Đổi")
  if (message.includes('thành')) {
    const newTimeText = message.split('thành')[1].trim();
    event.new_time = parseVietnameseTime(newTimeText);
    if (!event.new_time) {
      const newParsedTime = chrono.parse(newTimeText);
      if (newParsedTime[0]) {
        event.new_time = newParsedTime[0].start.date();
      }
    }
  }

  // Trích xuất nội dung
  event.content = extractContent(message);

  // Kiểm tra lặp lại
  if (message.includes('mỗi ngày')) event.repeat = 'daily';
  if (message.includes('mỗi tuần')) event.repeat = 'weekly';

  // Trích xuất người tham gia (nếu có "với")
  if (message.includes('với')) {
    const participant = message.split('với')[1].trim().split(' ')[0];
    event.participants.push(participant);
  }

  return event;
};

// Hàm gửi tin nhắn
const sendMessage = async (recipientId, text) => {
  try {
    await axios.post('https://graph.facebook.com/v13.0/me/messages', {
      recipient: { id: recipientId },
      message: { text }
    }, {
      params: { access_token: PAGE_ACCESS_TOKEN }
    });
    console.log('Đã gửi tin nhắn:', text);
  } catch (error) {
    console.error('Lỗi gửi tin nhắn:', error.response ? error.response.data : error.message);
  }
};

// Tự ping để giữ bot hoạt động
cron.schedule('*/10 * * * *', async () => {
  try {
    // Thay URL bằng URL thực tế của bot trên Render
    const response = await axios.get('https://chat-bot-uh7j.onrender.com');
    console.log('Tự ping thành công:', response.data);
  } catch (error) {
    console.error('Lỗi tự ping:', error.message);
  }
});

// Xử lý tin nhắn từ nhóm
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body.entry[0].messaging[0];
    const senderId = data.sender.id;
    const message = data.message.text;

    if (message.includes('Hủy')) {
      const event = parseMessage(message.replace('Hủy', '').trim());
      const deletedEvent = await Event.findOneAndDelete({
        senderId,
        content: event.content,
        time: event.time
      });

      if (deletedEvent) {
        await sendMessage(senderId, `Đã hủy: ${event.content} vào ${formatDateTime(event.time)}`);
      } else {
        await sendMessage(senderId, `Không tìm thấy sự kiện: ${event.content} vào ${formatDateTime(event.time)} để hủy.`);
      }
    } else if (message.includes('Đổi')) {
      const parts = message.split('thành');
      const oldEvent = parseMessage(parts[0].replace('Đổi', '').trim());
      const newEvent = parseMessage(parts[1].trim());

      if (!newEvent.new_time) {
        await sendMessage(senderId, 'Không thể xác định thời gian mới. Vui lòng thử lại với định dạng như: "lúc 10h sáng ngày mai".');
        return res.sendStatus(200);
      }

      const updatedEvent = await Event.findOneAndUpdate(
        { senderId, content: oldEvent.content, time: oldEvent.time },
        { time: newEvent.new_time },
        { new: true }
      );

      if (updatedEvent) {
        await sendMessage(senderId, `Đã đổi: ${oldEvent.content} từ ${formatDateTime(oldEvent.time)} thành ${formatDateTime(newEvent.new_time)}`);
      } else {
        await sendMessage(senderId, `Không tìm thấy sự kiện: ${oldEvent.content} vào ${formatDateTime(oldEvent.time)} để thay đổi.`);
      }
    } else {
      const event = parseMessage(message);
      if (!event.time) {
        await sendMessage(senderId, 'Không thể xác định thời gian. Vui lòng thử lại với định dạng như: "Họp ngày 15/10 lúc 9h sáng".');
        return res.sendStatus(200);
      }
      const newEvent = new Event({
        senderId,
        content: event.content,
        time: event.time,
        repeat: event.repeat,
        participants: event.participants
      });
      await newEvent.save();
      await sendMessage(senderId, `Đã lên lịch: ${formatDateTime(event.time)}: ${event.content}`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Lỗi xử lý tin nhắn:', error);
    res.sendStatus(500);
  }
});

// Lập lịch gửi nhắc nhở
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date(); // Thời gian hiện tại ở UTC
    const nowVietnam = toVietnamTime(now); // Chỉ dùng để hiển thị
    const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000); // 1 giờ sau (UTC)
    const oneDayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 ngày sau (UTC)
    const tomorrow = toVietnamTime(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const tomorrowUTC = toUTCTime(tomorrow);

    console.log(`Thời gian hiện tại (UTC): ${now.toISOString()}`);
    console.log(`Thời gian hiện tại (Việt Nam): ${formatDateTime(now)}`);

    // Nhắc nhở trước 1 giờ
    const eventsSoon = await Event.find({
      time: {
        $gt: now, // Sự kiện trong tương lai
        $lte: oneHourLater // Trong vòng 1 giờ tới
      },
      status: 'pending'
    });

    for (let event of eventsSoon) {
      console.log(`Nhắc nhở trước 1 giờ cho sự kiện: ${event.content} vào ${event.time.toISOString()} (now: ${now.toISOString()})`);
      await sendMessage(event.senderId, `🔔 Nhắc nhở trước 1 giờ: ${formatDateTime(event.time)}: ${event.content}`);
      // Không đặt status thành 'sent' ở đây để tránh ảnh hưởng đến thông báo "đúng giờ"
    }

    // Nhắc nhở trước 1 ngày
    const eventsFar = await Event.find({
      time: {
        $gt: tomorrowUTC, // Sự kiện sau ngày mai
        $lte: oneDayLater // Trong vòng 1 ngày tới
      },
      status: 'pending'
    });

    for (let event of eventsFar) {
      console.log(`Nhắc nhở trước 1 ngày cho sự kiện: ${event.content} vào ${event.time.toISOString()} (now: ${now.toISOString()})`);
      await sendMessage(event.senderId, `🔔 Nhắc nhở trước 1 ngày: ${formatDateTime(event.time)}: ${event.content}`);
      // Không đặt status thành 'sent' ở đây để tránh ảnh hưởng đến thông báo "đúng giờ"
    }

    // Nhắc nhở đúng giờ
    const eventsNow = await Event.find({
      time: { $lte: now },
      status: 'pending'
    });

    for (let event of eventsNow) {
      console.log(`Nhắc nhở đúng giờ cho sự kiện: ${event.content} vào ${event.time.toISOString()} (now: ${now.toISOString()})`);
      await sendMessage(event.senderId, `🔔 Đã đến giờ: ${formatDateTime(event.time)}: ${event.content}`);
      event.status = 'sent';
      await event.save();

      if (event.repeat === 'daily') {
        event.time = new Date(event.time.getTime() + 24 * 60 * 60 * 1000);
        event.status = 'pending';
        await event.save();
      }
    }
  } catch (error) {
    console.error('Lỗi khi gửi nhắc nhở:', error);
  }
});

// Khởi động server
app.listen(PORT, () => console.log(`Server chạy trên port ${PORT}`));