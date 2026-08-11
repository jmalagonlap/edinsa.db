# -*- coding: utf-8 -*-
"""
build_facturacion.py — ETL de facturación EDINSA → embedding en index.html

Lee "facturación edinsa.xlsx", agrega por mes y tipo de servicio (antes de IVA)
e incrusta el JSON en <script id="billing-data"> dentro de public/index.html.

Uso:
    python build_facturacion.py
"""
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
XLSX_FILE = os.path.join(BASE_DIR, "facturación edinsa.xlsx")
HTML_FILE = os.path.join(BASE_DIR, "public", "index.html")

BILLING_RE = re.compile(
    r'(<script id="billing-data" type="application/json">)(.*?)(</script>)',
    re.DOTALL,
)

CATEGORY_MAP = {
    "LAP-SERTELE":      "telemetria",
    "LAP - MANT COMP":  "mantenimiento",
    "LAP - INST COMP":  "instalacion",
    "LAP-ALQEQUI":      "equipos",
}
CATEGORY_LABELS = {
    "telemetria":    "Servicio mensual cámaras IA",
    "mantenimiento": "Bolsa de mantenimiento",
    "instalacion":   "Instalación",
    "equipos":       "Suministro de equipos",
}
CATEGORY_COLORS = {
    "telemetria":    "#BC1818",
    "mantenimiento": "#E85D1E",
    "instalacion":   "#1D4ED8",
    "equipos":       "#7C3AED",
}


def _valor_neto(row):
    """Lee Valor Neto Artículo respetando el desplazamiento cuando Bodega es numérico."""
    bodega = row[15] if len(row) > 15 else None
    if isinstance(bodega, (int, float)) and not isinstance(bodega, bool):
        return row[23] if len(row) > 23 else 0
    return row[22] if len(row) > 22 else 0


def build_billing():
    try:
        import openpyxl
    except ImportError:
        print("[ERROR] Instala openpyxl: pip install openpyxl")
        return None

    if not os.path.exists(XLSX_FILE):
        print(f"[ERROR] No se encontró {XLSX_FILE}")
        return None

    wb = openpyxl.load_workbook(XLSX_FILE, read_only=True, data_only=True)
    ws = wb.active

    monthly = defaultdict(lambda: defaultdict(float))  # month -> category -> sum
    skipped = 0
    processed = 0

    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            continue  # header

        fecha = row[10] if len(row) > 10 else None
        referencia = str(row[13]).strip() if len(row) > 13 and row[13] else ""
        cat = CATEGORY_MAP.get(referencia)

        if not fecha or not cat:
            skipped += 1
            continue

        if hasattr(fecha, "strftime"):
            month = fecha.strftime("%Y-%m")
        else:
            skipped += 1
            continue

        val = _valor_neto(row)
        if val is None:
            val = 0

        monthly[month][cat] += float(val)
        processed += 1

    wb.close()

    months = sorted(monthly.keys())
    cats = list(CATEGORY_MAP.values())

    monthly_list = []
    for m in months:
        entry = {"month": m}
        total = 0
        for c in cats:
            v = round(monthly[m].get(c, 0), 2)
            entry[c] = v
            total += v
        entry["total"] = round(total, 2)
        if abs(total) < 1:
            continue  # omitir meses donde NF y re-emisión se anulan
        monthly_list.append(entry)

    totals_by_cat = {}
    for c in cats:
        totals_by_cat[c] = round(sum(e.get(c, 0) for e in monthly_list), 2)

    active_months = [e["month"] for e in monthly_list]

    data = {
        "generado": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "meses": active_months,
        "categorias": [
            {"clave": c, "label": CATEGORY_LABELS[c], "color": CATEGORY_COLORS[c]}
            for c in cats
        ],
        "mensual": monthly_list,
        "totales_por_categoria": totals_by_cat,
        "total_general": round(sum(totals_by_cat.values()), 2),
    }

    print(f"[OK] Facturación procesada: {processed} líneas, {len(months)} meses")
    for m in monthly_list:
        print(f"  {m['month']}: total={m['total']:,.0f}  tel={m['telemetria']:,.0f}  "
              f"mant={m['mantenimiento']:,.0f}  inst={m['instalacion']:,.0f}  equip={m['equipos']:,.0f}")
    return data


def embed_billing_in_html(data):
    if not os.path.exists(HTML_FILE):
        print(f"[WARN] No se encontró {HTML_FILE}")
        return
    with open(HTML_FILE, encoding="utf-8") as f:
        html = f.read()

    json_str = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    new_html, n = BILLING_RE.subn(lambda m: m.group(1) + json_str + m.group(3), html, count=1)
    if n == 0:
        print("[WARN] Marcador <script id='billing-data'> no encontrado en index.html.")
        return
    with open(HTML_FILE, "w", encoding="utf-8") as f:
        f.write(new_html)
    size_mb = os.path.getsize(HTML_FILE) / (1024 * 1024)
    print(f"[OK] Facturación incrustada en index.html ({size_mb:.2f} MB)")


if __name__ == "__main__":
    data = build_billing()
    if data:
        embed_billing_in_html(data)
