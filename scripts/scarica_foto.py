#!/usr/bin/env python3
# ==============================================================================
# scarica_foto.py — scarica una foto per ogni calciatore del listone e la
# salva in data/foto/<nome-slug>.jpg, pronta per essere letta dal sito.
#
# IMPORTANTE — leggi prima di usarlo:
#   - Questo script NON è mai stato eseguito né testato in questo momento:
#     l'ambiente in cui è stato scritto non può raggiungere Bing/Google per
#     verificarlo (rete isolata). Uso lo stesso principio del tuo programma
#     desktop dell'asta di agosto (ricerca "Cognome Nome calciatore" su un
#     motore di immagini, senza API a pagamento), ma con Bing Immagini invece
#     di Google Immagini, perché la sua pagina HTML è più semplice da leggere
#     "al volo" senza libreria dedicata. Se hai ancora il codice che scaricava
#     le foto per il programma desktop e funzionava bene, è più sicuro e
#     veloce riusare QUELLO: basta che salvi le immagini con lo stesso nome
#     file che usa questo script (vedi funzione slugify qui sotto, oppure
#     importa slugify_nome da questo file) dentro data/foto/.
#   - Bing (come Google) può cambiare la struttura della pagina o bloccare
#     richieste troppo frequenti in qualunque momento: se lo script smette di
#     trovare immagini, è quasi certamente questo il motivo, non un errore
#     nel listone. In tal caso prova ad aumentare --delay, oppure aggiorna
#     manualmente le foto mancanti mettendo tu stesso i file in data/foto/.
#   - Uso pensato per una lega privata tra amici: rispetta un ritardo
#     ragionevole tra una richiesta e l'altra (--delay, default 1.5s) e non
#     lanciarlo ripetutamente a raffica.
#
# USO:
#   pip install requests pillow --break-system-packages   (una sola volta)
#   python3 scripts/scarica_foto.py data/il_tuo_listone.csv
#
# Opzioni:
#   --out data/foto      cartella di destinazione (default: data/foto)
#   --delay 1.5          secondi di pausa tra un calciatore e l'altro
#   --forza              riscarica anche le foto già presenti
# ==============================================================================
import argparse
import csv
import json
import re
import sys
import time
import unicodedata
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Manca la libreria 'requests'. Installala con:\n  pip install requests pillow --break-system-packages")

try:
    from PIL import Image
    from io import BytesIO
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False
    print("⚠ Libreria 'pillow' non trovata: le foto verranno salvate cosi' come scaricate, "
          "senza ridimensionamento/normalizzazione. Consigliato: pip install pillow --break-system-packages")

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def slugify_nome(nome_completo: str) -> str:
    """STESSA identica logica di slugify() in js/common.js: deve produrre lo
    stesso nome file che il sito web si aspetta di trovare."""
    s = nome_completo.strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")  # rimuove accenti
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s or "calciatore"


def leggi_listone(percorso_csv: str):
    """Legge sia il formato ufficiale (colonna 'Nome' unica + 'Fuori lista')
    sia il formato semplice (cognome/nome separati), come parseListoneCsv()
    in js/common.js."""
    with open(percorso_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        rows = list(reader)
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]

    def idx(*nomi):
        for n in nomi:
            if n in header:
                return header.index(n)
        return -1

    i_cognome = idx("cognome")
    i_nome = idx("nome")
    formato_ufficiale = i_cognome == -1 and i_nome != -1
    if formato_ufficiale:
        i_cognome = i_nome
        i_nome = -1
    i_fuori_lista = idx("fuori lista", "fuorilista")

    giocatori = []
    for row in rows[1:]:
        if not row or all(not c.strip() for c in row):
            continue
        if i_fuori_lista != -1 and i_fuori_lista < len(row) and row[i_fuori_lista].strip():
            continue  # escluso, come sul sito
        cognome = row[i_cognome].strip() if i_cognome < len(row) else ""
        nome = row[i_nome].strip() if (i_nome != -1 and i_nome < len(row)) else ""
        if not cognome:
            continue
        nome_completo = f"{cognome} {nome}".strip()
        giocatori.append(nome_completo)
    return giocatori


def cerca_url_immagine(query: str, session: requests.Session) -> str | None:
    """Cerca su Bing Immagini e restituisce l'URL del primo risultato utile."""
    url = "https://www.bing.com/images/search"
    params = {"q": f"{query} calciatore", "form": "HDRSC2", "first": "1"}
    resp = session.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=15)
    resp.raise_for_status()
    # Bing incorpora i metadati di ogni risultato in un attributo m="{...json...}"
    # dentro i tag <a class="iusc">.
    matches = re.findall(r'class="iusc"[^>]*m="([^"]+)"', resp.text)
    for raw in matches[:5]:
        try:
            data = json.loads(raw.replace("&quot;", '"'))
            murl = data.get("murl")
            if murl and murl.startswith("http"):
                return murl
        except (json.JSONDecodeError, AttributeError):
            continue
    return None


def scarica_e_salva(img_url: str, destinazione: Path, session: requests.Session) -> bool:
    resp = session.get(img_url, headers={"User-Agent": USER_AGENT}, timeout=15)
    resp.raise_for_status()
    contenuto = resp.content
    if HAS_PILLOW:
        img = Image.open(BytesIO(contenuto)).convert("RGB")
        img.thumbnail((500, 500))
        img.save(destinazione, "JPEG", quality=85)
    else:
        destinazione.write_bytes(contenuto)
    return True


def main():
    ap = argparse.ArgumentParser(description="Scarica le foto dei calciatori del listone.")
    ap.add_argument("csv", help="Percorso del file CSV del listone")
    ap.add_argument("--out", default="data/foto", help="Cartella di destinazione (default: data/foto)")
    ap.add_argument("--delay", type=float, default=1.5, help="Secondi di pausa tra un calciatore e l'altro")
    ap.add_argument("--forza", action="store_true", help="Riscarica anche le foto già presenti")
    args = ap.parse_args()

    cartella = Path(args.out)
    cartella.mkdir(parents=True, exist_ok=True)

    giocatori = leggi_listone(args.csv)
    if not giocatori:
        sys.exit("Nessun calciatore trovato nel CSV (controlla il percorso/formato del file).")
    print(f"Trovati {len(giocatori)} calciatori nel listone.")

    session = requests.Session()
    trovate, mancanti, saltate = 0, [], 0

    for i, nome_completo in enumerate(giocatori, 1):
        slug = slugify_nome(nome_completo)
        destinazione = cartella / f"{slug}.jpg"
        if destinazione.exists() and not args.forza:
            saltate += 1
            continue
        print(f"[{i}/{len(giocatori)}] {nome_completo} -> {slug}.jpg ...", end=" ", flush=True)
        try:
            img_url = cerca_url_immagine(nome_completo, session)
            if not img_url:
                print("nessuna immagine trovata")
                mancanti.append(nome_completo)
                continue
            scarica_e_salva(img_url, destinazione, session)
            print("OK")
            trovate += 1
        except Exception as e:
            print(f"errore ({e})")
            mancanti.append(nome_completo)
        time.sleep(args.delay)

    print(f"\nFatto: {trovate} foto scaricate, {saltate} già presenti, {len(mancanti)} non trovate.")
    if mancanti:
        print("Calciatori senza foto (mostreranno la sagoma segnaposto sul sito):")
        for n in mancanti:
            print(f"  - {n}")


if __name__ == "__main__":
    main()
