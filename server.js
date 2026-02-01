require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const streamPipeline = promisify(require("stream").pipeline);

const app = express();
app.use(bodyParser.json());

// --- CONFIGURAÇÃO DA GROQ ---
const GROQ_API_URL = "https://api.groq.com/openai/v1"; 

// --- FUNÇÃO 1: Enviar Mensagem no WhatsApp (COM CORREÇÃO DE 9 DÍGITOS) ---
async function enviarMensagem(to, text) {
  try {
    // CORREÇÃO BRASIL: Se o número for brasileiro (55), tiver DDD e 8 dígitos (total 12), adiciona o 9.
    // Ex: transforma 557582452296 em 5575982452296
    if (to.length === 12 && to.startsWith("55")) {
        console.log(`🔧 Corrigindo número: transformando ${to} (sem 9) para...`);
        to = to.slice(0, 4) + "9" + to.slice(4);
        console.log(`✨ ...${to} (com 9)`);
    }

    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: text },
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    // Confirmação visual no terminal
    console.log("✅ MENSAGEM ENVIADA COM SUCESSO PARA:", to); 

  } catch (error) {
    console.error("❌ Erro ao enviar msg:", error.response?.data || error.message);
  }
}

// --- FUNÇÃO 2: Baixar Áudio do WhatsApp ---
async function baixarAudio(mediaId) {
  try {
    const urlRes = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    const mediaUrl = urlRes.data.url;

    const writer = fs.createWriteStream("temp_audio.ogg");
    const response = await axios({
      url: mediaUrl,
      method: "GET",
      responseType: "stream",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });

    await streamPipeline(response.data, writer);
    return "temp_audio.ogg";
  } catch (error) {
    console.error("❌ Erro baixar áudio:", error.response?.data || error.message);
    return null;
  }
}

// --- FUNÇÃO 3: Transcrever Áudio (Via Groq Whisper) ---
async function transcreverAudio(filePath) {
  try {
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("model", "whisper-large-v3"); 
    formData.append("response_format", "json");

    const response = await axios.post(
      `${GROQ_API_URL}/audio/transcriptions`, 
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
      }
    );
    return response.data.text;
  } catch (error) {
    console.error("❌ Erro transcrição Groq:", error.response?.data || error.message);
    return "";
  }
}

// --- FUNÇÃO 4: Interpretar Gasto (Via Groq Llama 3) ---
async function interpretarGasto(texto) {
  try {
    const response = await axios.post(
      `${GROQ_API_URL}/chat/completions`, 
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `Você é um assistente financeiro pessoal.
            Analise a mensagem e extraia os dados em JSON.
            
            Se for um gasto, retorne:
            {"acao": "gasto", "valor": 10.50, "categoria": "Alimentação", "item": "Pizza"}
            
            Se não for gasto claro, retorne:
            {"acao": "desconhecido"}
            
            Responda APENAS o JSON, sem markdown.`
          },
          { role: "user", content: texto },
        ],
        temperature: 0.1
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
    );
    
    let content = response.data.choices[0].message.content;
    content = content.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(content);
  } catch (error) {
    console.error("❌ Erro Inteligência Groq:", error.response?.data || error.message);
    return { acao: "erro" };
  }
}

// --- ROTA DO WEBHOOK (Verificação do Facebook) ---
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === process.env.VERIFY_TOKEN
  ) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(400);
  }
});

// --- ROTA DO WEBHOOK (Recebimento de Mensagens) ---
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0]?.changes?.[0]?.value;
    if (entry?.messages?.[0]) {
      const msg = entry.messages[0];
      const from = msg.from; // O número de quem enviou

      // --- LOG DE DIAGNÓSTICO ---
      console.log("========================================");
      console.log("📞 MENSAGEM RECEBIDA DE:", from);
      // ---------------------------

      let textoDoUsuario = "";

      // 1. Processar Áudio ou Texto
      if (msg.type === "audio") {
        console.log("🎤 Áudio detectado...");
        const arquivo = await baixarAudio(msg.audio.id);
        if (arquivo) {
          textoDoUsuario = await transcreverAudio(arquivo);
          console.log("📝 Texto transcrito:", textoDoUsuario);
        }
      } else if (msg.type === "text") {
        textoDoUsuario = msg.text.body;
        console.log("📝 Texto recebido:", textoDoUsuario);
      }

      // 2. Inteligência Artificial e Resposta
      if (textoDoUsuario) {
        const dados = await interpretarGasto(textoDoUsuario);

        if (dados.acao === "gasto") {
          await enviarMensagem(
            from,
            `✅ *Registrado com Sucesso!*\n\n💰 Valor: R$${dados.valor}\n📂 Categoria: ${dados.categoria}\n🛒 Item: ${dados.item}`
          );
        } else if (dados.acao === "erro") {
           await enviarMensagem(from, "Ocorreu um erro interno na IA.");
        } else {
          await enviarMensagem(from, "Não entendi o gasto. Tente falar: 'Gastei 20 reais no uber'");
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 Servidor rodando com GROQ na porta ${process.env.PORT}`);
});
