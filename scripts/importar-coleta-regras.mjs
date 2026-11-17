// Regras puras da importação da coleta (planilha do site de coleta + fotos) para o banco.
// Sem acesso a rede ou disco: testado em tests/importar-coleta.test.mjs.
// O programa que usa estas regras é scripts/importar-coleta.mjs (veja docs/18-importar-coleta.md).

import { createHash } from "node:crypto";

/** Minúsculas, sem acento e com espaços simples: base para comparar textos. */
export function normalizarTexto(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const PALAVRAS = "prateleira|gaveta|gaveteiro|caixa-gaveteiro|caixa|posicao";

/**
 * Transforma o texto solto da coleta (ex.: "ARMARIO 4 PRATELEIRA 1 GV-16") em:
 *  - grupo: "armario" (com numero), "bancada" ou "confirmar" (local padrão de exemplo ou ilegível)
 *  - detalhe: o que vem depois do armário, já limpo (ex.: "Prateleira 1, Gaveta 16")
 */
export function interpretarLocal(texto) {
  const original = String(texto ?? "").replace(/\s+/g, " ").trim();
  const n = normalizarTexto(original);
  if (!n) return { grupo: "confirmar", numero: null, detalhe: "" };
  if (n.includes("bancada")) return { grupo: "bancada", numero: null, detalhe: "" };
  // "Armário 01 > Prateleira A": é o local de exemplo que o site de coleta oferece, não um local real
  if (n.includes(">")) return { grupo: "confirmar", numero: null, detalhe: original };

  const m = /arm\w*\s*0*(\d+)/.exec(n); // pega também "ARMRAIO 4"
  if (!m) return { grupo: "confirmar", numero: null, detalhe: original };

  let resto = n.slice(m.index + m[0].length);
  resto = resto.replace(/[,;]+/g, " ");
  resto = resto.replace(/\bpr[a-z]*ra\s*0*(\d+)\b/g, " prateleira $1 "); // prateleira, praleira, preteleira
  resto = resto.replace(/\b(?:gv|gaveta)\b[\s-]*0*(\d+)/g, " gaveta $1 ");
  resto = resto.replace(/\bcaixa\s+gaveteiro\b/g, " caixa-gaveteiro ");
  resto = resto.replace(/\bprateleira (\d+)\s+(\d+)\s*$/, "prateleira $1 gaveta $2"); // "prateleira 1, 13"
  resto = resto.replace(/\s+/g, " ").trim();
  resto = resto.replace(new RegExp(`\\s+(?=(?:${PALAVRAS})\\b)`, "g"), ", ");
  resto = resto.replace(/caixa-gaveteiro/g, "caixa gaveteiro");
  resto = resto.replace(/\b(?!e\b)[a-z]\b/g, (letra) => letra.toUpperCase()); // "caixa f" -> "caixa F" (o "e" de "15 e 19" fica)
  resto = resto.replace(/\bposicao\b/g, "posição"); // só depois: o \b do JavaScript trata "ã" como fim de palavra
  const detalhe = resto
    .split(", ")
    .map((parte) => (parte ? parte[0].toUpperCase() + parte.slice(1) : parte))
    .join(", ");
  return { grupo: "armario", numero: Number(m[1]), detalhe };
}

/** Chave estável de uma posição (para criar cada uma só uma vez). */
export function chavePosicao(loc) {
  return `${loc.grupo}|${loc.numero ?? ""}|${normalizarTexto(loc.detalhe)}`;
}

/** Nome da categoria como aparece no sistema: "QUÍMICO" vira "Químico", "bancada" vira "Bancada", sigla curta fica. */
export function nomeCategoria(texto) {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "Outros";
  if (t.length <= 3 && t === t.toUpperCase()) return t; // EPI, KIT? (KIT vira Kit abaixo), siglas de até 3 letras
  const baixa = t.toLowerCase();
  return baixa[0].toUpperCase() + baixa.slice(1);
}

/** Nome da posição: o detalhe limpo, ou "Geral" quando só havia o armário. */
export function nomePosicao(loc) {
  return loc.detalhe || "Geral";
}

/** Entre várias fotos do mesmo código, a mais recente (o nome traz data e hora: ALI-001_20261110T175120.jpg). */
export function escolherFoto(arquivos) {
  return [...arquivos].sort().at(-1) ?? null;
}

/** Chave de idempotência fixa por código: rodar a importação de novo não duplica a entrada de estoque. */
export function chaveEntrada(codigo) {
  const h = createHash("sha1").update(`importacao-coleta:${codigo}`).digest("hex");
  const variante = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variante}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
