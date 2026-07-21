# -*- coding: utf-8 -*-
"""
build_analysis.py — Análisis ejecutivo con IA a partir de data.json.

Requiere:
  pip install anthropic
  Variable de entorno ANTHROPIC_API_KEY

Llamado automáticamente desde build_data.py al final del ETL.
"""
import json
import os
from datetime import datetime


# ── Helpers ─────────────────────────────────────────────────────────────────

def _rate(total, vehicles):
    return total / vehicles if vehicles else 0


# ── Estadísticas para el prompt ──────────────────────────────────────────────

def compute_stats(data: dict) -> dict:
    """Extrae y calcula estadísticas clave del dict de data.json."""
    meses = data["meses"]
    monthly_idx = {r["month"]: r for r in data["monthly_totals"]}
    eventos_meta = data["eventos_meta"]

    # Últimos 3 meses con vehículos activos
    activos = [m for m in meses if monthly_idx.get(m, {}).get("vehicles_active", 0) > 0]
    last3 = activos[-3:]
    prev3 = activos[-6:-3]

    def month_rate(m):
        r = monthly_idx.get(m, {})
        return _rate(r.get("total", 0), r.get("vehicles_active", 0))

    def type_rate(m, clave):
        r = monthly_idx.get(m, {})
        return _rate(r.get("by_type", {}).get(clave, 0), r.get("vehicles_active", 0))

    # Detalle últimos 3 meses
    monthly_rates = [
        {
            "month": m,
            "total": monthly_idx[m]["total"],
            "vehicles_active": monthly_idx[m]["vehicles_active"],
            "rate": round(month_rate(m), 2),
        }
        for m in last3 if m in monthly_idx
    ]

    # Promedio últimos 3 vs anteriores 3 (ponderado por vehículos)
    avg_l3 = sum(month_rate(m) for m in last3) / len(last3) if last3 else 0
    avg_p3 = sum(month_rate(m) for m in prev3) / len(prev3) if prev3 else 0
    delta = avg_l3 - avg_p3
    delta_pct = (delta / avg_p3 * 100) if avg_p3 else 0

    # Tendencia por tipo de evento
    type_trends = []
    for ev in eventos_meta:
        clave, nombre = ev["clave"], ev["nombre"]
        rl = [type_rate(m, clave) for m in last3]
        rp = [type_rate(m, clave) for m in prev3]
        al = sum(rl) / len(rl) if rl else 0
        ap = sum(rp) / len(rp) if rp else 0
        d = al - ap
        dp = (d / ap * 100) if ap > 0 else (100.0 if al > 0 else 0.0)
        type_trends.append({
            "nombre": nombre,
            "avg_last3": round(al, 3),
            "avg_prev3": round(ap, 3),
            "delta": round(d, 3),
            "delta_pct": round(dp, 1),
        })
    type_trends.sort(key=lambda x: x["delta"], reverse=True)

    # Interanual: rate ponderado por vehículos (suma_eventos / suma_vehículos)
    yoy: dict = {}
    for r in data["monthly_totals"]:
        year = r["month"][:4]
        veh = r.get("vehicles_active", 0)
        if not veh:
            continue
        if year not in yoy:
            yoy[year] = {"events": 0, "veh_months": 0, "months": 0}
        yoy[year]["events"] += r["total"]
        yoy[year]["veh_months"] += veh
        yoy[year]["months"] += 1

    yoy_summary = {}
    for yr, d in sorted(yoy.items()):
        yoy_summary[yr] = {
            "rate_weighted": round(_rate(d["events"], d["veh_months"]), 2),
            "total_events": int(d["events"]),
            "avg_vehicles": round(d["veh_months"] / d["months"], 1) if d["months"] else 0,
            "months_with_data": d["months"],
        }

    prev3_label = f"{prev3[0]} → {prev3[-1]}" if len(prev3) >= 2 else (prev3[0] if prev3 else "—")

    return {
        "periodo_total": f"{meses[0]} → {meses[-1]}",
        "last3_months": monthly_rates,
        "prev3_label": prev3_label,
        "trend_overall": {
            "avg_rate_last3": round(avg_l3, 2),
            "avg_rate_prev3": round(avg_p3, 2),
            "delta": round(delta, 2),
            "delta_pct": round(delta_pct, 1),
        },
        "most_increased": type_trends[0] if type_trends else None,
        "most_decreased": type_trends[-1] if type_trends else None,
        "type_trends": type_trends,
        "yoy": yoy_summary,
    }


# ── Llamada al API ────────────────────────────────────────────────────────────

def _load_api_key() -> str:
    """Busca ANTHROPIC_API_KEY en entorno o en un archivo .env del proyecto."""
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        return key
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_file):
        with open(env_file, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("ANTHROPIC_API_KEY="):
                    return line.split("=", 1)[1].strip().strip("\"'")
    return ""


def generate_analysis_html(stats: dict, cliente: str) -> str:
    """Llama a Claude Haiku para generar el análisis en HTML."""
    try:
        import anthropic
    except ImportError:
        print("[análisis] Instala el paquete: pip install anthropic")
        return ""

    api_key = _load_api_key()
    if not api_key:
        print("[análisis] ANTHROPIC_API_KEY no encontrada.")
        print("  Opción 1: $env:ANTHROPIC_API_KEY = 'sk-ant-...'  (sesión actual)")
        print("  Opción 2: Crear archivo .env con ANTHROPIC_API_KEY=sk-ant-...")
        return ""

    client = anthropic.Anthropic(api_key=api_key)
    fecha_gen = datetime.now().strftime("%Y-%m-%d %H:%M")

    prompt = f"""Eres un analista de seguridad vial especializado en flotas de transporte pesado.
Tu cliente es {cliente}. Analiza los datos del dashboard de eventos de cámaras AI y escribe un análisis ejecutivo.

NOTA IMPORTANTE: Todos los campos "rate" ya son eventos / vehículo / mes (métrica ponderada por flota activa).

DATOS ESTADÍSTICOS:
{json.dumps(stats, ensure_ascii=False, indent=2)}

INSTRUCCIONES DE FORMATO:
- Responde SOLO con HTML limpio (sin <html>, <head>, <body> ni CSS inline).
- Usa <h3> para títulos de sección, <p> para párrafos, <strong> para valores numéricos clave.
- Formato colombiano: punto para miles, coma para decimales. Ej: 23.4 → 23,4 · 1234.5 → 1.234,5
- Sé concreto: menciona los valores numéricos reales de los datos, no genéricos.
- Máximo 4 oraciones por sección (excepto conclusión: máximo 3).

ESTRUCTURA EXACTA (5 secciones, en este orden):

<h3>Tendencia eventos/vehículo/mes</h3>
<p>Describe el rate en cada uno de los últimos 3 meses (mes por mes). Compara el promedio de esos 3 meses vs los 3 anteriores: indica el valor absoluto y el porcentaje de cambio. Concluye si la flota mejoró o empeoró.</p>

<h3>Evolución interanual</h3>
<p>Compara el rate ponderado anual (events/veh/mes) año por año usando los datos de yoy. Identifica el año con mayor y menor tasa. Indica si hay tendencia de mejora o deterioro. Ten en cuenta que 2026 puede tener datos parciales.</p>

<h3>Evento en aumento ↑</h3>
<p>Nombra el tipo de evento que más subió en rate (eventos/vehículo) en los últimos 3 vs los 3 anteriores. Indica el nombre del evento, los valores de rate en ambos períodos, el delta absoluto y el % de cambio.</p>

<h3>Evento en descenso ↓</h3>
<p>Mismo formato: el tipo que más bajó, sus valores, delta y % de cambio.</p>

<h3>Conclusión y recomendación</h3>
<p>Una frase sobre el estado general de la flota. Una recomendación operacional concreta y accionable para el equipo de seguridad vial.</p>"""

    try:
        print("[análisis] Generando análisis con Claude Haiku 4.5…")
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1400,
            messages=[{"role": "user", "content": prompt}],
        )
        html_body = resp.content[0].text.strip()
        meta = (
            f'<p class="analysis-meta">'
            f'Análisis generado: {fecha_gen} · '
            f'Período: {stats["periodo_total"]} · '
            f'Modelo: Claude Haiku 4.5'
            f'</p>'
        )
        print("[análisis] Análisis generado exitosamente.")
        return meta + "\n" + html_body
    except Exception as exc:
        print(f"[análisis] Error al llamar la API: {exc}")
        return ""


# ── Punto de entrada ──────────────────────────────────────────────────────────

def build_analysis(data: dict) -> str:
    """Recibe el dict de data.json, devuelve HTML del análisis (o '' si falla)."""
    cliente = data.get("cliente", {}).get("nombre_largo", "EDINSA")
    stats = compute_stats(data)
    return generate_analysis_html(stats, cliente)
