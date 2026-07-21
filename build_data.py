# -*- coding: utf-8 -*-
"""
ETL para el Dashboard de Eventos EDINSA.

Lee todos los CSV "recentEvents-report*.csv" de la carpeta, los deduplica
(los archivos exportados se solapan en algunos rangos de fecha), normaliza
los nombres de evento y genera public/data.json con todos los agregados
que consume el dashboard (index.html + dashboard.js).

Uso:
    python build_data.py
"""
import csv
import glob
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE_DIR, "public")
OUT_FILE = os.path.join(OUT_DIR, "data.json")
HTML_FILE = os.path.join(OUT_DIR, "index.html")
FLEET_DB_FILE = os.path.join(BASE_DIR, "fleet_db.json")

SIN_PLAZA = "Sin plaza"


def load_fleet_db():
    """Carga fleet_db.json (generado por build_fleet_db.py) con la
    clasificación por Plaza y el histórico de km mensuales por placa.
    Si no existe todavía, el dashboard simplemente queda sin esa info
    (plaza / eventos por 1000 km) hasta que se corra build_fleet_db.py."""
    if os.path.exists(FLEET_DB_FILE):
        with open(FLEET_DB_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    print(f"[WARN] No se encontró {FLEET_DB_FILE}. Corre build_fleet_db.py para "
          f"habilitar Plaza y eventos/1000km. El dashboard se genera sin esa info.")
    return {"placas": {}, "km_mensual": {}}

EMBED_RE = re.compile(
    r'(<script id="embedded-data" type="application/json">)(.*?)(</script>)',
    re.DOTALL,
)
ANALYSIS_RE = re.compile(
    r'(<script id="ai-analysis" type="text/html">)(.*?)(</script>)',
    re.DOTALL,
)


def embed_data_in_html(data):
    """Incrusta el JSON dentro de index.html (script#embedded-data) para que
    el dashboard funcione abriendo el archivo directamente (file://), sin
    depender de fetch() a data.json (bloqueado por CORS en ese esquema)."""
    if not os.path.exists(HTML_FILE):
        print(f"[WARN] No se encontró {HTML_FILE}; se omite la incrustación de datos.")
        return
    with open(HTML_FILE, encoding="utf-8") as fh:
        html = fh.read()
    json_str = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    new_html, n = EMBED_RE.subn(lambda m: m.group(1) + json_str + m.group(3), html, count=1)
    if n == 0:
        print(f"[WARN] No se encontró el marcador <script id=\"embedded-data\"> en {HTML_FILE}.")
        return
    with open(HTML_FILE, "w", encoding="utf-8") as fh:
        fh.write(new_html)
    size_mb = os.path.getsize(HTML_FILE) / (1024 * 1024)
    print(f"[OK] Datos incrustados en {HTML_FILE} ({size_mb:.2f} MB)")


def embed_analysis_in_html(analysis_html: str):
    """Incrusta el HTML del análisis IA en script#ai-analysis dentro de index.html."""
    if not os.path.exists(HTML_FILE):
        return
    with open(HTML_FILE, encoding="utf-8") as fh:
        html = fh.read()
    # Escapar </ dentro del HTML para no romper el tag
    safe = analysis_html.replace("</", "<\\/")
    new_html, n = ANALYSIS_RE.subn(lambda m: m.group(1) + safe + m.group(3), html, count=1)
    if n == 0:
        print("[WARN] No se encontró el marcador <script id=\"ai-analysis\"> en index.html.")
        return
    with open(HTML_FILE, "w", encoding="utf-8") as fh:
        fh.write(new_html)
    print("[OK] Análisis IA incrustado en index.html.")

# Colores fijos por tipo de evento (paleta consistente con tds-dashboard)
EVENT_COLORS = {
    "cinturon_piloto":      "#D43F00",
    "distraido":            "#1D4ED8",
    "colision_advertencia": "#E85D1E",
    "bostezando":           "#7C3AED",
    "sin_cinturon":         "#059669",
    "colision_frontal":     "#DC2626",
    "salida_carril":        "#CA8A04",
    "otro":                 "#6B7280",
}

EVENT_LABELS = {
    "cinturon_piloto":      "Cinturón de seguridad no abrochado (Piloto)",
    "distraido":            "Conductor distraído",
    "colision_advertencia": "Advertencia de Colisión Frontal",
    "bostezando":           "Conductor bostezando",
    "sin_cinturon":         "Conducción sin cinturón de seguridad",
    "colision_frontal":     "Colisión frontal",
    "salida_carril":        "Salida de carril",
    "otro":                 "Otro",
}


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def normalize_event(raw):
    """Normaliza el nombre crudo de 'Evento' a una clave canónica estable."""
    n = strip_accents(raw).strip().lower()
    if "cinturon" in n and "no abrochado" in n:
        return "cinturon_piloto"
    if "distra" in n:
        return "distraido"
    if "advertencia" in n and "colision" in n:
        return "colision_advertencia"
    if "bostez" in n:
        return "bostezando"
    if "conduccion sin cinturon" in n or ("sin cinturon" in n and "conducc" in n):
        return "sin_cinturon"
    if n == "colision frontal" or ("colision" in n and "frontal" in n and "advertencia" not in n):
        return "colision_frontal"
    if "salida de carril" in n or "salida carril" in n:
        return "salida_carril"
    return "otro"


def parse_occurrences(raw):
    try:
        v = float(raw)
        if v != v or v <= 0:  # NaN guard
            return 1
        return v
    except (TypeError, ValueError):
        return 1


def month_key(date_str):
    # "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM"
    return date_str[:7]


def normalize_vehicle(raw):
    """El campo 'Nombre de Máquina' del CSV de eventos trae el prefijo 'CO_'
    (ej. 'CO_KSP252'); el resto del dato del cliente (BD PLACAS EDINSA, km
    mensuales) identifica los vehículos solo por la PLACA ('KSP252'), sin
    ese prefijo. Lo quitamos aquí para que ambas fuentes casen por placa."""
    v = raw.strip()
    if v.upper().startswith("CO_"):
        v = v[3:]
    return v


def main():
    files = sorted(glob.glob(os.path.join(BASE_DIR, "recentEvents-report*.csv")))
    print(f"Encontrados {len(files)} archivos CSV")

    seen_rows = set()
    raw_rows = 0
    dedup_rows = 0

    # Acumuladores
    monthly_event = defaultdict(lambda: defaultdict(float))           # month -> event_key -> count
    monthly_vehicle = defaultdict(lambda: defaultdict(float))         # month -> vehicle -> count
    monthly_vehicle_event = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))  # month -> vehicle -> event_key -> count
    vehicle_event_total = defaultdict(lambda: defaultdict(float))     # vehicle -> event_key -> count
    vehicle_first = {}
    vehicle_last = {}
    event_total = defaultdict(float)
    drivers_named = set()
    date_min = None
    date_max = None
    raw_event_names_seen = defaultdict(set)  # event_key -> set of raw labels seen (para verificación)

    for f in files:
        with open(f, encoding="utf-8") as fh:
            reader = csv.reader(fh, delimiter="\t")
            header = next(reader)
            idx = {name: i for i, name in enumerate(header)}
            i_evento = idx.get("Evento", 1)
            i_vehiculo = idx.get("Nombre de Máquina", 3)
            i_conductor = idx.get("Nombre Conductor", 5)
            i_fecha = idx.get("Fecha de generación", 6)
            i_ocurrencias = idx.get("Total Ocurrencias", 13)

            for row in reader:
                raw_rows += 1
                key = tuple(row)
                if key in seen_rows:
                    continue
                seen_rows.add(key)
                dedup_rows += 1

                evento_raw = row[i_evento].strip()
                vehiculo = normalize_vehicle(row[i_vehiculo])
                fecha = row[i_fecha].strip()
                conductor = row[i_conductor].strip() if i_conductor < len(row) else ""
                if not vehiculo or not fecha:
                    continue

                ekey = normalize_event(evento_raw)
                raw_event_names_seen[ekey].add(evento_raw)
                qty = parse_occurrences(row[i_ocurrencias]) if i_ocurrencias < len(row) else 1
                m = month_key(fecha)

                monthly_event[m][ekey] += qty
                monthly_vehicle[m][vehiculo] += qty
                monthly_vehicle_event[m][vehiculo][ekey] += qty
                vehicle_event_total[vehiculo][ekey] += qty
                event_total[ekey] += qty

                if vehiculo not in vehicle_first or m < vehicle_first[vehiculo]:
                    vehicle_first[vehiculo] = m
                if vehiculo not in vehicle_last or m > vehicle_last[vehiculo]:
                    vehicle_last[vehiculo] = m

                if conductor:
                    drivers_named.add(conductor)

                d = fecha[:10]
                if date_min is None or d < date_min:
                    date_min = d
                if date_max is None or d > date_max:
                    date_max = d

        print(f"  {os.path.basename(f)}: leídas {raw_rows} filas acumuladas (dedup: {dedup_rows})")

    print(f"\nTotal filas crudas: {raw_rows}")
    print(f"Total filas tras deduplicar: {dedup_rows}")
    print(f"Rango de fechas: {date_min} -> {date_max}")
    for ekey, names in raw_event_names_seen.items():
        print(f"  [{ekey}] <= {sorted(names)}")

    # ---- Construir lista continua de meses desde el primero hasta el último ----
    def month_add(m, n):
        y, mm = int(m[:4]), int(m[5:7])
        mm += n
        y += (mm - 1) // 12
        mm = (mm - 1) % 12 + 1
        return f"{y:04d}-{mm:02d}"

    months = []
    cur = date_min[:7]
    end = date_max[:7]
    while cur <= end:
        months.append(cur)
        cur = month_add(cur, 1)

    event_keys = sorted(event_total.keys(), key=lambda k: -event_total[k])

    # ---- vehiculos activos por mes y por tipo (para tasa correcta al filtrar por tipo) ----
    monthly_vehicles_active_by_type = defaultdict(lambda: defaultdict(set))
    for m, vehicles_in_month in monthly_vehicle_event.items():
        for v, types in vehicles_in_month.items():
            for ek, qty in types.items():
                if qty:
                    monthly_vehicles_active_by_type[m][ek].add(v)

    # ---- monthly_totals (serie principal) ----
    monthly_totals = []
    for m in months:
        total = sum(monthly_event.get(m, {}).values())
        active_vehicles = len(monthly_vehicle.get(m, {}))
        by_type = {ek: round(monthly_event.get(m, {}).get(ek, 0), 2) for ek in event_keys}
        vehicles_active_by_type = {
            ek: len(monthly_vehicles_active_by_type.get(m, {}).get(ek, ())) for ek in event_keys
        }
        rate = round(total / active_vehicles, 3) if active_vehicles else None
        monthly_totals.append({
            "month": m,
            "total": round(total, 2),
            "vehicles_active": active_vehicles,
            "vehicles_active_by_type": vehicles_active_by_type,
            "rate_per_vehicle": rate,
            "by_type": by_type,
        })

    # ---- vehicle_totals (para tabla / ranking / selector) ----
    vehicle_totals = []
    for v, by_type in vehicle_event_total.items():
        total = sum(by_type.values())
        first_m = vehicle_first[v]
        last_m = vehicle_last[v]
        # meses activos = meses con al menos 1 evento de este vehiculo, dentro de su rango
        months_with_data = sum(1 for m in months if monthly_vehicle.get(m, {}).get(v, 0) > 0)
        avg_per_active_month = round(total / months_with_data, 2) if months_with_data else 0
        vehicle_totals.append({
            "vehicle": v,
            "total": round(total, 2),
            "first_month": first_m,
            "last_month": last_m,
            "months_active": months_with_data,
            "avg_per_month": avg_per_active_month,
            "by_type": {ek: round(by_type.get(ek, 0), 2) for ek in event_keys},
        })
    vehicle_totals.sort(key=lambda r: -r["total"])

    # ---- matriz vehiculo x mes (total, todos los tipos) para la tabla pivot ----
    # sparse: solo meses con datos
    vehicle_month_matrix = {}
    for m in months:
        for v, qty in monthly_vehicle.get(m, {}).items():
            vehicle_month_matrix.setdefault(v, {})[m] = round(qty, 2)

    # ---- matriz vehiculo x mes x tipo, solo para los vehiculos (sparse), para drill-down ----
    vehicle_month_type = {}
    for m in months:
        for v, types in monthly_vehicle_event.get(m, {}).items():
            vm = vehicle_month_type.setdefault(v, {})
            vm[m] = {ek: round(qty, 2) for ek, qty in types.items() if qty}

    # ---- Plaza y km mensuales (fleet_db.json: BD PLACAS EDINSA + export de km) ----
    fleet_db = load_fleet_db()
    months_set = set(months)
    vehicle_plaza = {}
    vehicle_month_km = {}
    for v in vehicle_event_total:
        placa_info = fleet_db["placas"].get(v)
        vehicle_plaza[v] = placa_info["plaza"] if placa_info and placa_info.get("plaza") else SIN_PLAZA
        km_bucket = fleet_db["km_mensual"].get(v)
        if km_bucket:
            filtrado = {m: km for m, km in km_bucket.items() if m in months_set and km}
            if filtrado:
                vehicle_month_km[v] = filtrado

    monthly_km = defaultdict(float)
    for v, bucket in vehicle_month_km.items():
        for m, km in bucket.items():
            monthly_km[m] += km

    plazas_meta = sorted(set(vehicle_plaza.values()), key=lambda p: (p == SIN_PLAZA, p))

    km_totales = round(sum(monthly_km.values()), 2)
    eventos_totales_val = round(sum(event_total.values()), 2)

    kpis = {
        "vehiculos": len(vehicle_totals),
        "tipos_evento": len(event_keys),
        "conductores_identificados": len(drivers_named),
        "eventos_totales": eventos_totales_val,
        "meses_con_datos": len(months),
        "promedio_eventos_vehiculo_mes": round(
            sum(event_total.values()) / sum(m["vehicles_active"] for m in monthly_totals), 3
        ) if sum(m["vehicles_active"] for m in monthly_totals) else None,
        "km_totales": km_totales,
        "tasa_global_1000km": round(eventos_totales_val / (km_totales / 1000), 3) if km_totales else None,
        "vehiculos_con_km": len(vehicle_month_km),
        "plazas": plazas_meta,
    }

    # ---- agregar plaza, km y tasa/1000km a vehicle_totals y monthly_totals ----
    for row in vehicle_totals:
        v = row["vehicle"]
        km_v = round(sum(vehicle_month_km.get(v, {}).values()), 2)
        row["plaza"] = vehicle_plaza.get(v, SIN_PLAZA)
        row["km_total"] = km_v
        row["rate_per_1000km"] = round(row["total"] / (km_v / 1000), 3) if km_v else None

    for row in monthly_totals:
        km_m = round(monthly_km.get(row["month"], 0), 2)
        row["km_total"] = km_m
        row["rate_per_1000km"] = round(row["total"] / (km_m / 1000), 3) if km_m else None

    data = {
        "generado": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "cliente": {"nombre_corto": "EDINSA", "nombre_largo": "EDINSA"},
        "rango": {"desde": date_min, "hasta": date_max},
        "meses": months,
        "eventos_meta": [
            {"clave": ek, "nombre": EVENT_LABELS.get(ek, ek), "color": EVENT_COLORS.get(ek, "#6B7280")}
            for ek in event_keys
        ],
        "kpis": kpis,
        "plazas_meta": plazas_meta,
        "monthly_totals": monthly_totals,
        "vehicle_totals": vehicle_totals,
        "vehicle_month_matrix": vehicle_month_matrix,
        "vehicle_month_type": vehicle_month_type,
        "vehicle_plaza": vehicle_plaza,
        "vehicle_month_km": vehicle_month_km,
        "diagnostico": {
            "filas_crudas": raw_rows,
            "filas_tras_dedup": dedup_rows,
            "archivos": [os.path.basename(f) for f in files],
            "fleet_db_actualizado": fleet_db.get("actualizado"),
        },
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as out:
        json.dump(data, out, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(OUT_FILE) / (1024 * 1024)
    print(f"\n[OK] Generado {OUT_FILE} ({size_mb:.2f} MB)")

    embed_data_in_html(data)

    # Análisis ejecutivo IA (requiere ANTHROPIC_API_KEY + pip install anthropic)
    try:
        sys.path.insert(0, BASE_DIR)
        from build_analysis import build_analysis
        analysis_html = build_analysis(data)
        if analysis_html:
            embed_analysis_in_html(analysis_html)
    except Exception as exc:
        print(f"[análisis] Saltado ({exc})")


if __name__ == "__main__":
    main()
