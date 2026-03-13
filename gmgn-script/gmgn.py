import os
import sys
import time
import json
import logging
from playwright.sync_api import sync_playwright

# Force UTF-8 output di Windows terminal agar karakter unicode tidak error
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

TARGET_URL = "https://gmgn.ai/trend?chain=sol"
API_KEYWORD = "/api/v1/rank/sol/swaps/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/143.0.0.0 Safari/537.36"
)

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gmgn_api_response.json")

captured_responses: list[dict] = []


def handle_response(response):
    url = response.url
    if "gmgn.ai" in url and "/api/" in url:
        logger.info(f"[NET] {response.status} {url[:120]}")
    if API_KEYWORD in url:
        logger.info(f"[HIT] API tertangkap! Status={response.status} URL={url[:150]}")
        try:
            body = response.json()
            captured_responses.append({"url": url, "status": response.status, "data": body})
            logger.info(f"[HIT] JSON berhasil diparse. Keys: {list(body.keys()) if isinstance(body, dict) else 'list'}")
        except Exception as ex:
            try:
                text = response.text()
                logger.warning(f"[HIT] Bukan JSON, raw text (50 char): {text[:50]}")
            except Exception:
                pass
            logger.warning(f"[HIT] Gagal parse JSON: {ex}")


def safe_click(page, selector: str, label: str, timeout: int = 3000):
    try:
        page.click(selector, timeout=timeout)
        logger.info(f"[CLICK] '{label}' berhasil diklik.")
        time.sleep(1)
        return True
    except Exception:
        logger.info(f"[CLICK] '{label}' tidak ditemukan / sudah tidak ada.")
        return False


def run():
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                ]
            )
            logger.info("Chromium berhasil dibuka (headless).")
        except Exception as e:
            logger.error(f"Gagal buka browser: {e}")
            return

        context = browser.new_context(
            accept_downloads=True,
            viewport={"width": 1920, "height": 1080},
            user_agent=USER_AGENT,
        )
        page = context.new_page()
        page.on("response", handle_response)

        try:
            logger.info(f"Membuka: {TARGET_URL}")
            page.goto(TARGET_URL, timeout=90000, wait_until="domcontentloaded")
            logger.info(f"Halaman dimuat. Title: {page.title()}")

            time.sleep(7)

            # Tutup popup onboarding
            for label in ["Next", "Next", "Next", "Next", "Finish"]:
                safe_click(page, f"(//span[normalize-space()='{label}'])[1]", label)

            # Klik tab 5m
            time.sleep(2)
            safe_click(page, "text=5m", "5m tab", timeout=5000)

            # Klik Filter
            time.sleep(2)
            safe_click(page, "text=Filter", "Filter", timeout=5000)

            page.fill("(//input[@placeholder='Min'])[2]", "200")
            time.sleep(1)
            page.fill("(//input[@placeholder='Min'])[4]", "50")
            time.sleep(1)
            page.fill("(//input[@placeholder='Min'])[5]", "500")
            time.sleep(1)
            page.fill("(//input[@placeholder='Min'])[5]", "20")
            time.sleep(1)

            safe_click(page, "text=Apply", "Apply", timeout=5000)
            time.sleep(1)

            page.evaluate("window.scrollTo(0, 300)")
            time.sleep(2)
            page.evaluate("window.scrollTo(0, 0)")

            logger.info("Menunggu API response (maks 20 detik)...")
            for i in range(20):
                if captured_responses:
                    logger.info(f"Response tertangkap setelah {i+1} detik.")
                    break
                time.sleep(1)

            if captured_responses:
                result = captured_responses[-1]
                data = result["data"]

                with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                logger.info(f"JSON disimpan ke: {OUTPUT_PATH}")

                if isinstance(data, dict):
                    for key, val in data.items():
                        if isinstance(val, list):
                            logger.info(f"List '{key}' berisi {len(val)} item.")
                            break

                try:
                    preview = json.dumps(data, indent=2, ensure_ascii=True)
                    lines = preview.splitlines()
                    print("\n=== PREVIEW RESPONSE (50 baris pertama) ===")
                    print("\n".join(lines[:50]))
                    if len(lines) > 50:
                        print(f"... (+{len(lines)-50} baris lagi, lihat file: {OUTPUT_PATH})")
                except Exception as pe:
                    logger.warning(f"Preview tidak bisa ditampilkan: {pe}")
            else:
                logger.error("Tidak ada response API yang tertangkap dalam 20 detik.")
                logger.error("Kemungkinan: URL berbeda, elemen 5m tidak ada, atau Cloudflare masih blokir.")

        except Exception as e:
            logger.error(f"Error: {e}")
        finally:
            context.close()
            browser.close()
            logger.info("Browser ditutup.")


if __name__ == "__main__":
    run()
