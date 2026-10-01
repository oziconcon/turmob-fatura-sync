/**
 * TÜRMOB e-Fatura Sync
 * Portaldaki faturaları okuyup Supabase'e yazar.
 * Her gece GitHub Actions ile otomatik çalışır.
 *
 * Sütun yapısı (kesif2.js ile keşfedildi):
 * e-Fatura: [0]checkbox [1]Alıcı [2]FaturaNo [3]Tarih [4]GönderilmeTarihi [5]Tutar [6]Senaryo [7]Durum
 * e-Arşiv:  [0]checkbox [1]Alıcı [2]FaturaNo [3]Tarih [4]Tutar [5]FaturaTipi [6]FaturaDurumu
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const TURMOB_URL = "https://turmobefatura.luca.com.tr";
const USER  = process.env.TURMOB_USER;
const PASS  = process.env.TURMOB_PASS;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;

if (!USER || !PASS)  throw new Error("TURMOB_USER / TURMOB_PASS eksik");
if (!SUPA_URL || !SUPA_KEY) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY eksik");

const supabase = createClient(SUPA_URL, SUPA_KEY);

// ── Türkçe karakter normalize ──────────────────────────────────────────────
function normTR(s = "") {
  return s.toUpperCase()
    .replace(/İ/g,"I").replace(/Ğ/g,"G").replace(/Ü/g,"U")
    .replace(/Ş/g,"S").replace(/Ö/g,"O").replace(/Ç/g,"C")
    .replace(/[^A-Z0-9 ]/g," ").replace(/\s+/g," ").trim();
}

// ── Fuzzy eşleşme ───────────────────────────────────────────────────────────
function similarity(a, b) {
  a = normTR(a); b = normTR(b);
  if (!a || !b) return 0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  const aWords = a.split(" ");
  const bWords = b.split(" ");
  let wordMatch = 0;
  for (const w of aWords) if (w.length > 2 && bWords.some(bw => bw.includes(w) || w.includes(bw))) wordMatch++;
  return (matches / longer.length) * 0.6 + (wordMatch / Math.max(aWords.length, 1)) * 0.4;
}

// ── Supabase'den müşteri listesini çek ────────────────────────────────────
async function getMusteriler() {
  const { data, error } = await supabase.from("musteriler").select("id, ad");
  if (error) throw error;
  return data || [];
}

// ── Müşteri adını eşleştir ────────────────────────────────────────────────
function matchMusteri(ad, liste) {
  let best = null, bestScore = 0;
  for (const m of liste) {
    const s = similarity(ad, m.ad);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return bestScore >= 0.45 ? best : null;
}

// ── Tutarı parse et → sayı ve para birimi ─────────────────────────────────
// "886,80 USD" → { tutar: 886.80, para_birimi: "USD" }
// "9.600,00 TRY" → { tutar: 9600.00, para_birimi: "TRY" }
function parseTutar(s = "") {
  const m = s.trim().match(/^([\d.,]+)\s*([A-Z]{3})?$/);
  if (!m) return { tutar: 0, para_birimi: "TRY" };
  const sayi = parseFloat(m[1].replace(/\./g,"").replace(",",".")) || 0;
  return { tutar: sayi, para_birimi: m[2] || "TRY" };
}

// ── Tarihi ISO'ya çevir (gün.ay.yıl → yıl-ay-gün) ────────────────────────
function parseDate(s = "") {
  const m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}` : null;
}

// ── Fatura listesini çek ──────────────────────────────────────────────────
async function scrapeFaturaList(page, urlPath, tip) {
  const minDate = new Date();
  minDate.setDate(minDate.getDate() - 90);
  const dateStr = minDate.toISOString().slice(0,10);

  await page.goto(`${TURMOB_URL}${urlPath}?minDate=${dateStr}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("table tbody tr"))
      .map(tr => Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim()))
      .filter(r => r.length > 3);
  });

  console.log(`  ${tip}: ${rows.length} satır bulundu`);
  return rows.map(r => ({ tip, raw: r }));
}

// ── Satırı parse et ────────────────────────────────────────────────────────
// e-Fatura:  [0]chk [1]Alıcı [2]FaturaNo [3]Tarih [4]GönTarihi [5]Tutar ...
// e-Arşiv:   [0]chk [1]Alıcı [2]FaturaNo [3]Tarih [4]Tutar ...
function parseFaturaRow(raw, tip) {
  if (raw.length < 4) return null;

  const alici    = raw[1] || "";
  const fatura_no = raw[2] || "";
  const tarih    = parseDate(raw[3]);

  // Tutar sütunu: efatura'da index 5, earsiv'de index 4
  const tutarStr = tip === "efatura"
    ? (raw[5] || raw[4] || "")
    : (raw[4] || "");

  const { tutar, para_birimi } = parseTutar(tutarStr);

  if (!fatura_no || !alici) return null;
  return { fatura_no, tarih, alici, tutar, para_birimi, tip };
}

// ── Ana akış ──────────────────────────────────────────────────────────────
async function main() {
  const musteriler = await getMusteriler();
  console.log(`✓ ${musteriler.length} müşteri Supabase'den alındı`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Login
  console.log("Giriş yapılıyor...");
  await page.goto(TURMOB_URL, { waitUntil: "networkidle" });
  await page.fill('input[type="text"]',     USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(2000);

  const loginUrl = page.url();
  if (loginUrl.toLowerCase().includes("login")) {
    throw new Error("Giriş başarısız! Kullanıcı adı/şifre kontrol edin.");
  }
  console.log("✓ Giriş başarılı");

  // Fatura listelerini çek
  const allRows = [];
  try {
    const efatura = await scrapeFaturaList(page, "/OutgoingInvoice/OutgoingInvoiceList", "efatura");
    allRows.push(...efatura);
  } catch(e) { console.error("e-Fatura listesi hatası:", e.message); }

  try {
    const earsiv = await scrapeFaturaList(page, "/OutgoingInvoice/OutgoingArchiveList", "earsiv");
    allRows.push(...earsiv);
  } catch(e) { console.error("e-Arşiv listesi hatası:", e.message); }

  await browser.close();

  if (allRows.length === 0) {
    console.log("Hiç fatura bulunamadı.");
    return;
  }

  console.log(`\nToplam ${allRows.length} satır işlenecek...`);

  // Parse & eşleştir & upsert
  let eklenen = 0, atlanan = 0, eslesmeyen = 0;

  for (const { tip, raw } of allRows) {
    const parsed = parseFaturaRow(raw, tip);
    if (!parsed) { atlanan++; continue; }

    const musteri = matchMusteri(parsed.alici, musteriler);
    if (!musteri) {
      console.warn(`  ⚠ Müşteri eşleşmedi: "${parsed.alici}"`);
      eslesmeyen++;
      continue;
    }

    const { error } = await supabase.from("faturalar").upsert({
      musteri_id:   musteri.id,
      aciklama:     `${tip === "efatura" ? "e-Fatura" : "e-Arşiv"} — ${parsed.fatura_no}`,
      tutar:        parsed.tutar,
      para_birimi:  parsed.para_birimi,
      tarih:        parsed.tarih || new Date().toISOString().slice(0,10),
      fatura_no:    parsed.fatura_no,
      kaynak:       "turmob_sync"
    }, { onConflict: "fatura_no" });

    if (error) {
      // para_birimi sütunu yoksa tutarı yine de kaydet
      if (error.message && error.message.includes("para_birimi")) {
        const { error: e2 } = await supabase.from("faturalar").upsert({
          musteri_id:  musteri.id,
          aciklama:    `${tip === "efatura" ? "e-Fatura" : "e-Arşiv"} — ${parsed.fatura_no}`,
          tutar:       parsed.tutar,
          tarih:       parsed.tarih || new Date().toISOString().slice(0,10),
          fatura_no:   parsed.fatura_no,
          kaynak:      "turmob_sync"
        }, { onConflict: "fatura_no" });
        if (e2) { console.error("  ✗ Upsert hatası:", e2.message); atlanan++; }
        else { eklenen++; }
      } else {
        console.error("  ✗ Upsert hatası:", error.message);
        atlanan++;
      }
    } else { eklenen++; }
  }

  console.log(`\n✅ Sync tamamlandı:`);
  console.log(`   ${eklenen} fatura eklendi/güncellendi`);
  console.log(`   ${eslesmeyen} fatura müşteri eşleşmedi`);
  console.log(`   ${atlanan} satır atlandı`);
}

main().catch(e => { console.error("HATA:", e.message); process.exit(1); });
