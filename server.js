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

// --- ROTA "ESTOU VIVO" (PARA O RENDER NÃO DORMIR) ---
// É aqui que o UptimeRobot vai "bater" a cada 5 minutos
app.get("/", (req, res) => {
  res.send("🤖 Bot Financeiro está acordado e pronto!");
});

// --- FUNÇÃO 1: Enviar Mensagem no WhatsApp ---
async function enviarMensagem(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: text },
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
  } catch (error) {
    console.error("Erro ao enviar msg:", error.response?.data || error.message);
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

    // Nome temporário para o arquivo
    const fileName = `temp_audio_${Date.now()}.ogg`;
    const writer = fs.createWriteStream(fileName);
    
    const response = await axios({
      url: mediaUrl,
      method: "GET",
      responseType: "stream",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });

    await streamPipeline(response.data, writer);
    return fileName;
  } catch (error) {
    console.error("Erro baixar áudio:", error.response?.data || error.message);
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
    
    // Apagar arquivo temporário para não encher o servidor
    fs.unlinkSync(filePath); 
    
    return response.data.text;
  } catch (error) {
    console.error("Erro transcrição Groq:", error.response?.data || error.message);
    // Tenta apagar mesmo se der erro
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
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
            Analise a mensagem do usuário e extraia os dados em formato JSON.
            
            Regras:
            1. Se for um gasto, retorne: {"acao": "gasto", "valor": 0.00, "categoria": "Ex: Alimentação", "item": "Descrição curta"}
            2. Se não for gasto claro, retorne: {"acao": "desconhecido"}
            3. Responda ESTRITAMENTE o JSON, sem markdown, sem explicações.`
          },
          { role: "user", content: texto },
        ],
        temperature: 0.1
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
    );
    
    let content = response.data.choices[0].message.content;
    // Limpeza extra para garantir que o JSON venha limpo
    content = content.replace(/```json/g, "").replace(/```/g, "").trim();
    
    return JSON.parse(content);
  } catch (error) {
    console.error("Erro Inteligência Groq:", error.response?.data || error.message);
    return { acao: "erro" };
  }
}

// --- ROTA DE VERIFICAÇÃO DO FACEBOOK (GET) ---
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "financas123";

  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(400);
  }
});

// --- ROTA DE RECEBIMENTO DE MENSAGENS (POST) ---
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0]?.changes?.[0]?.value;
    
    // Verifica se tem mensagem e se não é status de entrega (sent/delivered/read)
    if (entry?.messages?.[0]) {
      const msg = entry.messages[0];
      const from = msg.from;
      let textoDoUsuario = "";

      // Feedback visual rápido
      // await enviarMensagem(from, "⏳ Processando...");

      try {
        // 1. Processar Áudio ou Texto
        if (msg.type === "audio") {
          console.log("🎤 Áudio recebido...");
          const arquivo = await baixarAudio(msg.audio.id);
          if (arquivo) {
            textoDoUsuario = await transcreverAudio(arquivo);
            console.log("📝 Texto transcrito:", textoDoUsuario);
          }
        } else if (msg.type === "text") {
          textoDoUsuario = msg.text.body;
          console.log("📩 Texto recebido:", textoDoUsuario);
        }

        // 2. Inteligência Artificial (Se tiver texto)
        if (textoDoUsuario) {
          const dados = await interpretarGasto(textoDoUsuario);

          if (dados.acao === "gasto") {
            await enviarMensagem(
              from,
              `✅ *Despesa Registrada!*\n\n💰 Valor: R$${dados.valor}\n📂 Categoria: ${dados.categoria}\n📝 Item: ${dados.item}`
            );
          } else if (dados.acao === "erro") {
             await enviarMensagem(from, "Tive um erro interno ao processar. Tente novamente.");
          } else {
            await enviarMensagem(from, `Não entendi se isso foi um gasto.\n\nVocê disse: _"${textoDoUsuario}"_\n\nTente: "Gastei 15 reais no almoço"`);
          }
        }
      } catch (err) {
        console.error("Erro geral:", err);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Porta dinâmica para o Render ou 3000 local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});