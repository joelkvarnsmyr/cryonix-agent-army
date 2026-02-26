import fs from 'fs';
import path from 'path';

const API_KEY = process.env.XAI_API_KEY;
const OUTPUT_DIR = './apps/website/public/images/guides';

const PROMPTS = {
  'best-crypto-trading-signals': 'A futuristic crypto trading control room, holographic screens with green rising charts, cinematic lighting, neon cyan accents, 8k resolution, 3d render.',
  'mcp-server-setup': 'A glowing digital brain connected to high-tech server racks with neon blue laser data streams, isometric 3d render, dark background.',
  'fail-closed-trading': 'A powerful glowing digital hexagonal shield protecting a glowing gold circuit board from red glitchy lightning, futuristic security concept.',
  'crypto-signal-scams': 'A dark digital void, a cracked crystal ball showing a red skull, glitchy data numbers, cinematic dark lighting.',
  'bollinger-squeeze-ai': 'Abstract 3d representation of two neon energy bands compressing a vibrating light wave until it explodes into a bright cyan starburst.',
  'ai-orchestration-architecture': 'Intricate glass clockwork machine, orange and purple glowing spheres inside gears, representing synchronized AI models, futuristic laboratory.',
  'the-drawdown-truth': 'A red 3d terrain of crashing data bars, with a single bright cyan glowing safety bridge cutting through the chaos, ultra-detailed.',
  'open-claw-setup': 'A futuristic robotic claw hand holding a glowing neon blue crypto coin, high-tech background with floating data screens, 3d render.'
};

async function generateImage(slug, prompt, retryCount = 0) {
  console.log(`Generating image for: ${slug} (Attempt ${retryCount + 1})...`);
  
  const url = 'https://api.x.ai/v1/images/generations';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "grok-imagine-image-pro",
        prompt: prompt,
        n: 1,
        response_format: "url"
      })
    });

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 503 && retryCount < 3) {
        console.warn(`⚠️ 503 error for ${slug}, retrying in 10s...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        return generateImage(slug, prompt, retryCount + 1);
      }
      console.error(`❌ API error (${response.status}): ${text}`);
      return;
    }

    const data = JSON.parse(text);

    if (data.data && data.data[0] && data.data[0].url) {
      const imageUrl = data.data[0].url;
      const imgRes = await fetch(imageUrl);
      const arrayBuffer = await imgRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      const filename = `${slug}.jpg`;
      const filepath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(filepath, buffer);
      console.log(`✅ Saved: ${filepath}`);
    } else {
      console.error(`❌ Unexpected response for ${slug}:`, text);
    }
  } catch (error) {
    if (retryCount < 3) {
      console.warn(`⚠️ Network error for ${slug}, retrying in 5s... ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      return generateImage(slug, prompt, retryCount + 1);
    }
    console.error(`❌ Error generating ${slug}:`, error.message);
  }
}

async function main() {
  if (!API_KEY) {
    console.error("Missing XAI_API_KEY environment variable.");
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  for (const [slug, prompt] of Object.entries(PROMPTS)) {
    await generateImage(slug, prompt);
    // Grok usually has decent rate limits but let's be polite
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

main();
