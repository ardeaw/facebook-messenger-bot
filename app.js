const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios"); 
const OpenAI = require("openai");
const path = require("path");

require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "images")));

const PORT = process.env.PORT || 3000;
// Verify Token
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
console.log(`PAGE_ACCESS_TOKEN : ${PAGE_ACCESS_TOKEN}`)
const PAGE_ID = process.env.PAGE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

axios.defaults.headers.common['Authorization'] = `Bearer ${OPENAI_API_KEY}`;

// ตรวจสอบว่ามีค่า PAGEACCESS_TOKEN หรือไม่
if (!PAGE_ACCESS_TOKEN) {
  console.error("PAGE_ACCESS_TOKEN is not set.");
  process.exit(1); // หยุดโปรแกรมหากไม่มีค่า PAGE_ACCESS_TOKEN
}

// ตั้งค่า OpenAI API
const openai = new OpenAI({
  // apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID,
});

// สร้าง Assistant (สร้างครั้งเดียว)
const assistant = openai.beta.assistants.create({
  // ตั้งค่่าตามต้องการ
  // name: "Expert Thai Seller",
  // ใส่คำสั่งที่ต้องการให้ทำ

  tools: [{ type: "file_search" }, { type: "code_interpreter" }],
  tool_resources: {
    file_search: {
      vector_store_ids: [process.env.VECTOR_STORE_ID],
    },
  },
  model: "gpt-4o",
  response_format: "auto",
});

// Webhook สำหรับการยืนยันกับ Facebook
app.get("/", (req, res) => {
  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Webhook สำหรับรับข้อความ
app.post("/", async (req, res) => {
  let body = req.body;

  // console.log("Received webhook event:", JSON.stringify(body, null, 2));
    

  if (body.object === "page") {
    for (const entry of body.entry) {
      let webhook_event = entry.messaging[0];
      let sender_psid = webhook_event.sender.id;

      if (webhook_event.message && webhook_event.message.text) {
        try {
          let response = await getGPTResponse(webhook_event.message.text);
          await callSendAPI(sender_psid, response);
        } catch (error) {
          console.error("Error getting GPT response:", error);
          let response = { text: "ขออภัย ไม่สามารถตอบกลับได้ในขณะนี้" };
          await callSendAPI(sender_psid, response);
        }
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

// ฟังก์ชันเรียกใช้ OpenAI Assistants model GPT-4o
async function getGPTResponse(messageText) {
  try {
    //Step 2: Create a Thread
    const thread = await openai.beta.threads.create();

    //Step 3:Add a Message to the Thread (เพิ่มข้อความของผูู้ใช้ลงใน Thread)
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: messageText,
    });

    return new Promise((resolve, reject) => {
      let assistantResponse = "";

      // สร้าง Run และสตรีมข้อความจากผู้ช่วย
      openai.beta.threads.runs
        .stream(thread.id, {
          assistant_id: process.env.ASSISTANT_ID,
        })
        .on("textDelta", (textDelta, snapshot) => {
          // สะสมข้อความที่ได้รับจากผู้ช่วย
          assistantResponse += textDelta.value;
        })
        // เมื่อสตรีมสิ้นสุด ให้คืนค่าข้อความที่สะสมไว้
        .on("end", () => {
          // ตรวจสอบว่าข้อความมีการขอส่งรูปภาพหรือไม่
          const imageRegex = /\[image_url:\s*(https?:\/\/[^\s]+)\]/;
          const match = assistantResponse.match(imageRegex);
          let imageUrl = null;

          if (match && match[1]) {
            imageUrl = match[1];
            // ลบแท็กรูปภาพออกจากข้อความตอบกลับ
            assistantResponse = assistantResponse.replace(match[0], "").trim();            
          }
          resolve({
            text: assistantResponse.replace(/【.*?†source*?】/g, ""),
            image: imageUrl,
          });
        })
        .on("error", (error) => {
          console.error("Error during streaming:", error);
          reject("ขออภัย ไม่สามารถตอบกลับได้ในขณะนี้");
        });        
    });
  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
    return { text: "ขออภัย ไม่สามารถตอบกลับได้ในขณะนี้" };
  }
}

// ฟังก์ชันส่งข้อความกลับไปยังผู้ใช้
async function callSendAPI(sender_psid, response) {  

  // ส่งข้อความกลับไปยังผู้ใช้
  if (response.image) {
    // ถ้ามีข้อความด้วย ส่งข้อความก่อนแล้วค่อยส่งรูปภาพ
    if (response.text) {
      await sendMessage(sender_psid, { text: response.text });
    }
    // ส่งรูปภาพ
    await sendMessage(sender_psid, {
      attachment: {
        type: "image",
        payload: {
          url: response.image,
          is_reusable: true,
        },
      },
    });
  } else if (response.text) {
    // ส่งข้อความอย่างเดียว
    await sendMessage(sender_psid, { text: response.text });
  }
}

// ฟังก์ชันส่งข้อความกลับไปยังผู้ใช้
// ฟังก์ชันช่วยในการส่งข้อความโดยใช้ axios
async function sendMessage(sender_psid, response) {
  let requestBody = {
    recipient: {
      id: sender_psid,
    },
    message: response,
  };

  // พิมพ์ข้อมูลสำหรับดีบัก
  // console.log({
  //   url: `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
  //   data: requestBody,
  // });
  try {
    const res = await axios({
      method: "POST",
      url: `https://graph.facebook.com/v20.0/me/messages`,
      params: {
        access_token: PAGE_ACCESS_TOKEN,
      },
      data: requestBody,
    });

    if (res.status === 200) {
      console.log("ข้อความส่งสำเร็จ");
    } else {
      console.log("ไม่สามารถส่งข้อความได้:", res.statusText);
    }
  } catch (err) {
    console.error(
      "เกิดข้อผิดพลาดในการส่งข้อความ",
      err.response ? err.response.data : err.message
    );
  }
}

app.listen(PORT, () => {
  console.log(`เซิร์ฟเวอร์เริ่มทำงานที่พอร์ต ${PORT}`);
});