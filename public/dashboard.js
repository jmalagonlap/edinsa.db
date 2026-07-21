/* ======================================================================
   Dashboard EDINSA — Eventos Cámaras AI
   Filtros: vehículo (drill-down), rango de meses, tipos de evento (multi).
   Indicador dinámico: eventos / vehículo / mes (toggle Total vs Tasa).
   ====================================================================== */
(function () {
  "use strict";

  if (window.ChartDataLabels) Chart.register(ChartDataLabels);
  Chart.defaults.font.family = '"Open Sans", Arial, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = "#4B5563";
  Chart.defaults.plugins.tooltip.backgroundColor = "rgba(17,24,39,0.92)";
  Chart.defaults.plugins.tooltip.titleFont = { weight: 600, size: 12 };
  Chart.defaults.plugins.tooltip.bodyFont = { size: 12 };
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.plugins.tooltip.boxPadding = 6;
  Chart.defaults.plugins.datalabels = { display: false };

  let G = {};
  const CHARTS = {};

  // ── Estado de filtros ───────────────────────────────────────────────────
  const state = {
    vehicle: null,        // código exacto o null = todos
    desde: null,           // "YYYY-MM"
    hasta: null,            // "YYYY-MM"
    types: new Set(),       // claves activas (vacío al iniciar -> se llena con todas)
    plazas: new Set(),      // plazas activas (vacío al iniciar -> se llena con todas)
    metric: "total",        // "total" | "rate" | "km1000"
  };

  const PLAZA_COLORS = {
    "T1-CENTRO":      "#BC1818",  // rojo oscuro ÁRTIMO
    "T1-OCCIDENTE":   "#E74615",  // módulo Operación
    "T1-COSTA":       "#ED720E",  // módulo BI (naranja)
    "T1-SANTANDERES": "#C23921",  // módulo Logística
    "T1-ANTIOQUIA":   "#EA5A3D",  // módulo Mantenimiento
    "Sin plaza":      "#9CA3AF",
  };
  function plazaColor(p) { return PLAZA_COLORS[p] || "#6B7280"; }
  function vehiclePlazaOf(v) { return G.vehicle_plaza[v] || "Sin plaza"; }

  // ── Utilidades ───────────────────────────────────────────────────────────
  function fmtNum(n, decimals) {
    if (n == null || isNaN(n)) return "—";
    if (decimals != null) return n.toLocaleString("es-CO", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return new Intl.NumberFormat("es-CO").format(Math.round(n));
  }
  function monthLabel(m) {
    const [y, mm] = m.split("-").map(Number);
    const M = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
    return `${M[mm - 1]} ${y}`;
  }
  function destroyChart(id) { if (CHARTS[id]) { CHARTS[id].destroy(); CHARTS[id] = null; } }
  function colorDim(hex) { return hex + "33"; }
  function eventMeta(key) { return G.eventos_meta.find(e => e.clave === key); }

  function allTypesSelected() { return state.types.size === G.eventos_meta.length; }
  function allPlazasSelected() { return state.plazas.size === G.plazas_meta.length; }

  function monthsInRange() {
    const i0 = G.meses.indexOf(state.desde);
    const i1 = G.meses.indexOf(state.hasta);
    return G.meses.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
  }

  // Suma de km por mes respetando el filtro de vehículo y de plaza
  // (independiente del filtro de tipo de evento, que no aplica a los km).
  function computeKmByMonth(months) {
    const km = {};
    months.forEach(m => km[m] = 0);
    if (state.vehicle) {
      const bucket = G.vehicle_month_km[state.vehicle] || {};
      months.forEach(m => { km[m] = bucket[m] || 0; });
      return km;
    }
    for (const v in G.vehicle_month_km) {
      if (!state.plazas.has(vehiclePlazaOf(v))) continue;
      const bucket = G.vehicle_month_km[v];
      months.forEach(m => { if (bucket[m]) km[m] += bucket[m]; });
    }
    return km;
  }

  // ── Agregación dinámica ─────────────────────────────────────────────────
  // Devuelve serie mensual: [{month, total, vehiclesActive, byType:{...}}]
  // `monthsOverride`: si se pasa, ignora el filtro de rango (desde/hasta) y
  // calcula sobre esa lista de meses (usado por el comparativo interanual).
  function computeMonthlySeries(monthsOverride) {
    const months = monthsOverride || monthsInRange();
    const typesArr = G.eventos_meta.map(e => e.clave);
    const useAllTypes = allTypesSelected();
    const km = computeKmByMonth(months);

    if (state.vehicle) {
      const vData = G.vehicle_month_type[state.vehicle] || {};
      return months.map(m => {
        const byTypeRaw = vData[m] || {};
        let total = 0;
        const byType = {};
        typesArr.forEach(t => {
          const v = state.types.has(t) ? (byTypeRaw[t] || 0) : 0;
          byType[t] = v;
          total += v;
        });
        return { month: m, total, vehiclesActive: total > 0 ? 1 : 0, byType, km: km[m] || 0 };
      });
    }

    if (useAllTypes && allPlazasSelected()) {
      // camino rápido: usar monthly_totals precalculado
      const byMonth = {};
      G.monthly_totals.forEach(r => { byMonth[r.month] = r; });
      return months.map(m => {
        const r = byMonth[m] || { total: 0, vehicles_active: 0, by_type: {} };
        return { month: m, total: r.total, vehiclesActive: r.vehicles_active, byType: r.by_type, km: km[m] || 0 };
      });
    }

    // tipos y/o plazas parciales: recalcular total y vehículos activos (unión) recorriendo la matriz completa
    const result = months.map(m => ({ month: m, total: 0, vehiclesActiveSet: new Set(), byType: {} }));
    const idxByMonth = {};
    months.forEach((m, i) => { idxByMonth[m] = i; });
    typesArr.forEach(t => { result.forEach(r => r.byType[t] = 0); });

    for (const veh in G.vehicle_month_type) {
      if (!state.plazas.has(vehiclePlazaOf(veh))) continue;
      const vData = G.vehicle_month_type[veh];
      for (const m in vData) {
        const i = idxByMonth[m];
        if (i == null) continue;
        const types = vData[m];
        let any = false;
        for (const t of typesArr) {
          if (!state.types.has(t)) continue;
          const q = types[t] || 0;
          if (q) {
            result[i].total += q;
            result[i].byType[t] += q;
            any = true;
          }
        }
        if (any) result[i].vehiclesActiveSet.add(veh);
      }
    }
    return result.map(r => ({ month: r.month, total: r.total, vehiclesActive: r.vehiclesActiveSet.size, byType: r.byType, km: km[r.month] || 0 }));
  }

  // Devuelve [{vehicle, total, byType:{...}, km, plaza}] ordenado desc por total
  function computeVehicleRanking() {
    const months = monthsInRange();
    const typesArr = G.eventos_meta.map(e => e.clave);
    const useAllTypes = allTypesSelected();
    const useAllMonths = months.length === G.meses.length;
    const useAllPlazas = allPlazasSelected();

    function kmFor(v) {
      const bucket = G.vehicle_month_km[v] || {};
      let s = 0;
      months.forEach(m => { if (bucket[m]) s += bucket[m]; });
      return Math.round(s * 100) / 100;
    }

    if (useAllTypes && useAllMonths && useAllPlazas) {
      return G.vehicle_totals.map(v => ({ vehicle: v.vehicle, total: v.total, byType: v.by_type, km: v.km_total, plaza: v.plaza }));
    }

    const monthSet = new Set(months);
    const out = [];
    for (const veh in G.vehicle_month_type) {
      if (!state.plazas.has(vehiclePlazaOf(veh))) continue;
      const vData = G.vehicle_month_type[veh];
      let total = 0;
      const byType = {};
      typesArr.forEach(t => byType[t] = 0);
      for (const m in vData) {
        if (!monthSet.has(m)) continue;
        const types = vData[m];
        typesArr.forEach(t => {
          if (!state.types.has(t)) return;
          const q = types[t] || 0;
          total += q;
          byType[t] += q;
        });
      }
      if (total > 0) out.push({ vehicle: veh, total, byType, km: kmFor(veh), plaza: vehiclePlazaOf(veh) });
    }
    out.sort((a, b) => b.total - a.total);
    return out;
  }

  // ── Banner de contexto de filtros ───────────────────────────────────────
  function renderFilterSummary() {
    const bits = [];
    if (state.vehicle) bits.push(`Vehículo: <strong>${state.vehicle}</strong>`);
    if (!allTypesSelected()) {
      const names = [...state.types].map(t => eventMeta(t)?.nombre).join(", ");
      bits.push(`Tipos: <strong>${names || "ninguno"}</strong>`);
    }
    if (!allPlazasSelected()) {
      bits.push(`Plaza: <strong>${[...state.plazas].join(", ") || "ninguna"}</strong>`);
    }
    const totalMeses = G.meses.length;
    const meses = monthsInRange();
    if (meses.length !== totalMeses) {
      bits.push(`Periodo: <strong>${monthLabel(meses[0])} – ${monthLabel(meses[meses.length - 1])}</strong>`);
    }
    document.getElementById("kpi-totales-sub").innerHTML = bits.length ? "(filtrado)" : "";
    document.getElementById("kpi-tasa-sub").innerHTML = state.metric === "rate" ? "" : "(prom.)";
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────
  function renderKpis() {
    const serie = computeMonthlySeries();
    const total = serie.reduce((a, r) => a + r.total, 0);
    const sumVehiclesActive = serie.reduce((a, r) => a + r.vehiclesActive, 0);
    const rate = sumVehiclesActive ? total / sumVehiclesActive : null;
    const kmTotal = serie.reduce((a, r) => a + (r.km || 0), 0);
    const rate1000 = kmTotal ? total / (kmTotal / 1000) : null;
    let pico = null;
    serie.forEach(r => { if (!pico || r.total > pico.total) pico = r; });

    const ranking = computeVehicleRanking();

    document.getElementById("kpi-vehiculos").textContent = state.vehicle ? "1" : fmtNum(ranking.length);
    document.getElementById("kpi-tipos").textContent = fmtNum(state.types.size);
    document.getElementById("kpi-conductores").textContent = state.vehicle ? "—" : fmtNum(G.kpis.conductores_identificados);
    document.getElementById("kpi-totales").textContent = fmtNum(total);
    document.getElementById("kpi-tasa").textContent = rate != null ? fmtNum(rate, 1) : "—";
    document.getElementById("kpi-mes-pico").textContent = pico && pico.total > 0 ? `${monthLabel(pico.month)} (${fmtNum(pico.total)})` : "—";
    document.getElementById("kpi-km").textContent = kmTotal ? fmtNum(kmTotal) : "—";
    document.getElementById("kpi-tasa-km").textContent = rate1000 != null ? fmtNum(rate1000, 1) : "—";
    document.getElementById("footer-totals").textContent = `${fmtNum(total)} eventos en el periodo seleccionado`;
    renderFilterSummary();
  }

  // ── Chips de tipo de evento ──────────────────────────────────────────────
  function renderChips() {
    const cont = document.getElementById("chips-eventos");
    cont.innerHTML = "";
    G.eventos_meta.forEach(ev => {
      const chip = document.createElement("div");
      chip.className = "chip" + (state.types.has(ev.clave) ? " active" : "");
      chip.style.borderColor = state.types.has(ev.clave) ? ev.color : "transparent";
      chip.innerHTML = `<span class="chip-dot" style="background:${ev.color}"></span>${ev.nombre}`;
      chip.addEventListener("click", () => {
        if (state.types.has(ev.clave)) {
          if (state.types.size === 1) return; // no permitir dejar 0 tipos activos
          state.types.delete(ev.clave);
        } else {
          state.types.add(ev.clave);
        }
        renderChips();
        renderAll();
      });
      cont.appendChild(chip);
    });
  }

  // ── Chips de plaza ───────────────────────────────────────────────────────
  function renderChipsPlazas() {
    const cont = document.getElementById("chips-plazas");
    cont.innerHTML = "";
    G.plazas_meta.forEach(p => {
      const color = plazaColor(p);
      const chip = document.createElement("div");
      chip.className = "chip" + (state.plazas.has(p) ? " active" : "");
      chip.style.borderColor = state.plazas.has(p) ? color : "transparent";
      chip.innerHTML = `<span class="chip-dot" style="background:${color}"></span>${p}`;
      chip.addEventListener("click", () => {
        if (state.plazas.has(p)) {
          if (state.plazas.size === 1) return; // no permitir dejar 0 plazas activas
          state.plazas.delete(p);
        } else {
          state.plazas.add(p);
        }
        renderChipsPlazas();
        renderAll();
      });
      cont.appendChild(chip);
    });
  }

  // ── Selects de mes y datalist de vehículos ──────────────────────────────
  function renderMonthSelects() {
    const desdeSel = document.getElementById("filtro-mes-desde");
    const hastaSel = document.getElementById("filtro-mes-hasta");
    desdeSel.innerHTML = "";
    hastaSel.innerHTML = "";
    G.meses.forEach(m => {
      desdeSel.innerHTML += `<option value="${m}">${monthLabel(m)}</option>`;
      hastaSel.innerHTML += `<option value="${m}">${monthLabel(m)}</option>`;
    });
    desdeSel.value = state.desde;
    hastaSel.value = state.hasta;
    desdeSel.addEventListener("change", () => {
      state.desde = desdeSel.value;
      if (G.meses.indexOf(state.desde) > G.meses.indexOf(state.hasta)) {
        state.hasta = state.desde;
        hastaSel.value = state.hasta;
      }
      renderAll();
    });
    hastaSel.addEventListener("change", () => {
      state.hasta = hastaSel.value;
      if (G.meses.indexOf(state.hasta) < G.meses.indexOf(state.desde)) {
        state.desde = state.hasta;
        desdeSel.value = state.desde;
      }
      renderAll();
    });
  }

  function renderVehicleDatalist() {
    const dl = document.getElementById("lista-vehiculos");
    dl.innerHTML = G.vehicle_totals.map(v => `<option value="${v.vehicle}">`).join("");
    const input = document.getElementById("filtro-vehiculo");
    input.addEventListener("change", () => {
      const val = input.value.trim();
      state.vehicle = G.vehicle_month_matrix[val] ? val : null;
      renderAll();
    });
    input.addEventListener("input", () => {
      if (input.value.trim() === "") { state.vehicle = null; renderAll(); }
    });
  }

  // ── Tendencia mensual ────────────────────────────────────────────────────
  function renderTendencia() {
    destroyChart("tendencia-mensual");
    const serie = computeMonthlySeries();
    const ctx = document.getElementById("tendencia-mensual").getContext("2d");
    const metric = state.metric;
    const data = serie.map(r => {
      if (metric === "rate") return r.vehiclesActive ? r.total / r.vehiclesActive : null;
      if (metric === "km1000") return r.km ? r.total / (r.km / 1000) : null;
      return r.total;
    });
    const label = metric === "rate" ? "Eventos / vehículo activo"
      : metric === "km1000" ? "Eventos / 1.000 km"
      : "Total eventos";
    const color = state.vehicle ? "#7C3AED" : "#1D4ED8";
    CHARTS["tendencia-mensual"] = new Chart(ctx, {
      type: "line",
      data: {
        labels: serie.map(r => monthLabel(r.month)),
        datasets: [{
          label, data, borderColor: color, backgroundColor: color + "1A",
          tension: 0.35, fill: true, borderWidth: 2.5, pointRadius: 2, pointHoverRadius: 5,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => {
            const r = serie[c.dataIndex];
            if (metric === "rate") return ` ${fmtNum(c.parsed.y, 1)} eventos/vehículo · ${fmtNum(r.vehiclesActive)} vehículos activos`;
            if (metric === "km1000") return ` ${fmtNum(c.parsed.y, 1)} eventos/1.000km · ${fmtNum(r.km)} km recorridos`;
            return ` ${fmtNum(c.parsed.y)} eventos · ${fmtNum(r.vehiclesActive)} vehículos activos`;
          } } },
        },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => fmtNum(v) }, grid: { color: "#F0F1F3" } },
          x: { ticks: { autoSkip: true, maxTicksLimit: 18, font: { size: 10 } }, grid: { display: false } },
        },
      },
    });
  }

  // ── Comparativo interanual (mismo mes, distintos años) ──────────────────
  const MONTH_NAMES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const YEAR_COLORS = ["#9CA3AF", "#0891B2", "#1D4ED8", "#7C3AED", "#DB2777", "#D97706"];

  // Devuelve { years: ["2023", ...], grid: { "2023": [valEne, valFeb, ..., valDic], ... } }
  // grid[year][monthIdx] = {total, vehiclesActive, km} o null si ese mes no existe en los datos.
  function computeYearlyGrid() {
    const serie = computeMonthlySeries(G.meses); // ignora el filtro de rango de meses
    const grid = {};
    const years = [];
    serie.forEach(r => {
      const year = r.month.slice(0, 4);
      const idx = parseInt(r.month.slice(5, 7), 10) - 1;
      if (!grid[year]) { grid[year] = new Array(12).fill(null); years.push(year); }
      grid[year][idx] = { total: r.total, vehiclesActive: r.vehiclesActive, km: r.km };
    });
    years.sort();
    return { years, grid };
  }

  let anualMetric = "rate";

  function renderComparativoAnual() {
    destroyChart("comparativo-anual");
    const { years, grid } = computeYearlyGrid();
    const metric = anualMetric;
    const ctx = document.getElementById("comparativo-anual").getContext("2d");
    CHARTS["comparativo-anual"] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: MONTH_NAMES,
        datasets: years.map((y, i) => ({
          label: y,
          data: grid[y].map(cell => {
            if (!cell || !cell.total) return null;
            if (metric === "rate") return cell.vehiclesActive ? cell.total / cell.vehiclesActive : null;
            if (metric === "km1000") return cell.km ? cell.total / (cell.km / 1000) : null;
            return cell.total;
          }),
          backgroundColor: YEAR_COLORS[i % YEAR_COLORS.length],
          borderRadius: 3, maxBarThickness: 26,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", align: "start", labels: { boxWidth: 10, boxHeight: 10, padding: 8, font: { size: 11 } } },
          tooltip: { mode: "index", intersect: false, callbacks: { label: c => {
            const cell = grid[c.dataset.label][c.dataIndex];
            if (!cell || !cell.total) return ` ${c.dataset.label}: sin datos`;
            if (metric === "rate") return ` ${c.dataset.label}: ${fmtNum(c.parsed.y, 1)} eventos/vehículo (${fmtNum(cell.vehiclesActive)} vehículos)`;
            if (metric === "km1000") return ` ${c.dataset.label}: ${fmtNum(c.parsed.y, 1)} eventos/1.000km (${fmtNum(cell.km)} km)`;
            return ` ${c.dataset.label}: ${fmtNum(c.parsed.y)} eventos`;
          } } },
        },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => fmtNum(v) }, grid: { color: "#F0F1F3" } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  // ── Donut % por tipo ─────────────────────────────────────────────────────
  function renderDonut() {
    destroyChart("porcentajes");
    const serie = computeMonthlySeries();
    const totals = {};
    G.eventos_meta.forEach(e => totals[e.clave] = 0);
    serie.forEach(r => G.eventos_meta.forEach(e => totals[e.clave] += (r.byType[e.clave] || 0)));
    const arr = G.eventos_meta.filter(e => state.types.has(e.clave));
    const ctx = document.getElementById("porcentajes").getContext("2d");
    CHARTS.porcentajes = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: arr.map(a => a.nombre),
        datasets: [{ data: arr.map(a => totals[a.clave]),
          backgroundColor: arr.map(a => a.color),
          borderColor: "#FFFFFF", borderWidth: 2 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "55%",
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const clickedKey = arr[elements[0].index].clave;
          if (state.types.has(clickedKey)) {
            if (state.types.size === 1) return; // al menos un tipo activo
            state.types.delete(clickedKey);
          } else {
            state.types.add(clickedKey);
          }
          renderChips();
          renderAll();
        },
        onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? "pointer" : "default"; },
        plugins: {
          legend: { position: "right", labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: c => {
            const t = c.dataset.data.reduce((a, b) => a + b, 0);
            return ` ${fmtNum(c.parsed)}  (${t ? (c.parsed / t * 100).toFixed(1) : 0}%)`;
          } } },
          datalabels: {
            display: c => { const t = c.dataset.data.reduce((a, b) => a + b, 0); return t && c.dataset.data[c.dataIndex] / t > 0.04; },
            color: "#FFFFFF", font: { weight: 700, size: 11 },
            formatter: (v, c) => { const t = c.dataset.data.reduce((a, b) => a + b, 0); return t ? (v / t * 100).toFixed(1) + "%" : ""; },
          },
        },
      },
    });
  }

  // ── Vehículos activos por mes ────────────────────────────────────────────
  function renderVehiculosActivos() {
    destroyChart("vehiculos-activos");
    const serie = computeMonthlySeries();
    const ctx = document.getElementById("vehiculos-activos").getContext("2d");
    CHARTS["vehiculos-activos"] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: serie.map(r => monthLabel(r.month)),
        datasets: [{ label: "Vehículos activos", data: serie.map(r => r.vehiclesActive),
          backgroundColor: "#0891B2", borderRadius: 3, maxBarThickness: 26 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${fmtNum(c.parsed.y)} vehículos` } } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#F0F1F3" } },
          x: { ticks: { autoSkip: true, maxTicksLimit: 14, font: { size: 10 } }, grid: { display: false } },
        },
      },
    });
  }

  // ── Detalle mensual apilado por tipo ────────────────────────────────────
  function renderDetalleMensual() {
    destroyChart("detalle-mensual");
    const serie = computeMonthlySeries();
    const tipos = G.eventos_meta.filter(e => state.types.has(e.clave));
    const ctx = document.getElementById("detalle-mensual").getContext("2d");
    CHARTS["detalle-mensual"] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: serie.map(r => monthLabel(r.month)),
        datasets: tipos.map(t => ({
          label: t.nombre, data: serie.map(r => r.byType[t.clave] || 0),
          backgroundColor: t.color, borderRadius: 2,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", align: "start", labels: { boxWidth: 10, boxHeight: 10, padding: 8, font: { size: 11 } } },
          tooltip: { mode: "index", intersect: false },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 18, font: { size: 10 } } },
          y: { stacked: true, beginAtZero: true, ticks: { callback: v => fmtNum(v) }, grid: { color: "#F0F1F3" } },
        },
      },
    });
  }

  // ── Top vehículos ────────────────────────────────────────────────────────
  function renderTopVehiculos() {
    destroyChart("top-vehiculos");
    const ranking = computeVehicleRanking();
    const N = 20;
    const top = ranking.slice(0, N);
    const tipos = G.eventos_meta.filter(e => state.types.has(e.clave));
    document.getElementById("top-vehiculos-title").textContent =
      `Top ${Math.min(N, top.length)} vehículos con más eventos` + (state.vehicle ? ` — contexto: ${state.vehicle}` : "");
    const ctx = document.getElementById("top-vehiculos").getContext("2d");
    CHARTS["top-vehiculos"] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: top.map(v => v.vehicle),
        datasets: tipos.map(t => ({
          label: t.nombre, data: top.map(v => v.byType[t.clave] || 0),
          backgroundColor: t.color, borderRadius: 2,
        })),
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", align: "start", labels: { boxWidth: 10, padding: 8, font: { size: 11 } } },
          tooltip: { mode: "index", intersect: false },
        },
        scales: {
          x: { stacked: true, beginAtZero: true, ticks: { callback: v => fmtNum(v) }, grid: { color: "#F0F1F3" } },
          y: { stacked: true, grid: { display: false }, ticks: { font: { size: 10, family: "JetBrains Mono" } } },
        },
        onClick: (evt, el) => {
          if (el.length > 0) {
            const veh = top[el[0].index].vehicle;
            document.getElementById("filtro-vehiculo").value = veh;
            state.vehicle = veh;
            renderAll();
          }
        },
        onHover: (evt, el) => { evt.native.target.style.cursor = el.length ? "pointer" : "default"; },
      },
    });
  }

  // ── Tabla pivote vehículo x mes ──────────────────────────────────────────
  let pivotSort = { col: "total", dir: -1 };

  // Eventos de un vehículo en un mes, respetando los tipos seleccionados.
  function vehMonthEventos(vehicle, m) {
    const vData = G.vehicle_month_type[vehicle] || {};
    const t = vData[m] || {};
    let s = 0;
    G.eventos_meta.forEach(e => { if (state.types.has(e.clave)) s += (t[e.clave] || 0); });
    return s;
  }
  function vehMonthKm(vehicle, m) {
    return (G.vehicle_month_km[vehicle] || {})[m] || 0;
  }
  // Valor de la celda según la métrica activa de la tabla.
  function pivotCellValue(metric, vehicle, m) {
    const ev = vehMonthEventos(vehicle, m);
    if (metric === "km") return vehMonthKm(vehicle, m);
    if (metric === "km1000") {
      const km = vehMonthKm(vehicle, m);
      return km ? ev / (km / 1000) : null;
    }
    return ev;
  }
  function pivotFmt(metric, v) {
    if (v == null) return "—";
    if (v === 0) return "·";
    return metric === "km1000" ? fmtNum(v, 1) : fmtNum(v);
  }

  function renderPivot() {
    const months = monthsInRange();
    const ranking = computeVehicleRanking();
    const search = document.getElementById("tabla-buscar").value.trim().toLowerCase();
    const limitSel = document.getElementById("tabla-limite").value;
    const metric = document.getElementById("tabla-metrica").value;

    let rows = ranking;
    if (search) rows = rows.filter(r => r.vehicle.toLowerCase().includes(search));

    // Total de fila según la métrica activa.
    function rowTotal(r) {
      if (metric === "eventos") return r.total;
      if (metric === "km") return months.reduce((a, m) => a + vehMonthKm(r.vehicle, m), 0);
      const ev = months.reduce((a, m) => a + vehMonthEventos(r.vehicle, m), 0);
      const km = months.reduce((a, m) => a + vehMonthKm(r.vehicle, m), 0);
      return km ? ev / (km / 1000) : null;
    }

    if (pivotSort.col === "vehicle") {
      rows = [...rows].sort((a, b) => pivotSort.dir * a.vehicle.localeCompare(b.vehicle));
    } else if (pivotSort.col === "total") {
      rows = [...rows].sort((a, b) => pivotSort.dir * ((rowTotal(a) ?? -Infinity) - (rowTotal(b) ?? -Infinity)));
    } else if (pivotSort.col.startsWith("m:")) {
      const mm = pivotSort.col.slice(2);
      const getVal = r => pivotCellValue(metric, r.vehicle, mm) ?? -Infinity;
      rows = [...rows].sort((a, b) => pivotSort.dir * (getVal(a) - getVal(b)));
    }

    const total = rows.length;
    const limit = limitSel === "all" ? total : Math.min(parseInt(limitSel, 10), total);
    const shown = rows.slice(0, limit);

    // Promedio para resaltar celdas "calientes"
    let cellSum = 0, cellCount = 0;
    shown.forEach(r => months.forEach(m => {
      const v = pivotCellValue(metric, r.vehicle, m);
      if (v) { cellSum += v; cellCount++; }
    }));
    const avgCell = cellCount ? cellSum / cellCount : 0;

    const metricLabel = metric === "km" ? "Km" : metric === "km1000" ? "Eventos/1.000km" : "Eventos";

    const head = document.getElementById("pivot-head");
    head.innerHTML = `<th data-col="vehicle">Vehículo</th><th data-col="total">${metricLabel}</th>` +
      months.map(m => `<th data-col="m:${m}">${monthLabel(m)}</th>`).join("");

    const body = document.getElementById("pivot-body");
    const rowsHtml = shown.map(r => {
      const rt = rowTotal(r);
      const cells = months.map(m => {
        const v = pivotCellValue(metric, r.vehicle, m);
        const cls = !v ? "pivot-cell-zero" : (avgCell && v > avgCell * 2 ? "pivot-cell-hot" : "");
        return `<td class="${cls}">${pivotFmt(metric, v)}</td>`;
      }).join("");
      return `<tr><td>${r.vehicle}</td><td>${pivotFmt(metric, rt)}</td>${cells}</tr>`;
    }).join("");
    body.innerHTML = rowsHtml || `<tr><td colspan="${2 + months.length}" style="text-align:center;color:var(--color-text-muted);padding:20px;">Sin resultados</td></tr>`;

    document.getElementById("pivot-footer").textContent =
      `Mostrando ${shown.length} de ${total} vehículos · ${months.length} meses (${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}) · métrica: ${metricLabel}`;

    head.querySelectorAll("th").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        pivotSort.dir = pivotSort.col === col ? -pivotSort.dir : -1;
        pivotSort.col = col;
        renderPivot();
      });
    });
  }

  // ── Render global ────────────────────────────────────────────────────────
  function renderAll() {
    renderKpis();
    renderTendencia();
    renderComparativoAnual();
    renderDonut();
    renderVehiculosActivos();
    renderDetalleMensual();
    renderTopVehiculos();
    renderPivot();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  function initFilterControls() {
    state.desde = G.meses[0];
    state.hasta = G.meses[G.meses.length - 1];
    G.eventos_meta.forEach(e => state.types.add(e.clave));
    G.plazas_meta.forEach(p => state.plazas.add(p));

    renderChips();
    renderChipsPlazas();
    renderMonthSelects();
    renderVehicleDatalist();

    document.getElementById("metric-toggle").addEventListener("click", e => {
      const btn = e.target.closest(".metric-btn");
      if (!btn) return;
      e.currentTarget.querySelectorAll(".metric-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.metric = btn.dataset.metric;
      renderTendencia();
    });

    document.getElementById("metric-toggle-anual").addEventListener("click", e => {
      const btn = e.target.closest(".metric-btn");
      if (!btn) return;
      e.currentTarget.querySelectorAll(".metric-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      anualMetric = btn.dataset.metric;
      renderComparativoAnual();
    });

    document.getElementById("tabla-buscar").addEventListener("input", () => renderPivot());
    document.getElementById("tabla-limite").addEventListener("change", () => renderPivot());
    document.getElementById("tabla-metrica").addEventListener("change", () => renderPivot());

    document.getElementById("btn-limpiar-filtros").addEventListener("click", () => {
      state.vehicle = null;
      state.desde = G.meses[0];
      state.hasta = G.meses[G.meses.length - 1];
      state.types = new Set(G.eventos_meta.map(e => e.clave));
      state.plazas = new Set(G.plazas_meta);
      document.getElementById("filtro-vehiculo").value = "";
      document.getElementById("tabla-buscar").value = "";
      document.getElementById("tabla-metrica").value = "eventos";
      document.getElementById("filtro-mes-desde").value = state.desde;
      document.getElementById("filtro-mes-hasta").value = state.hasta;
      renderChips();
      renderChipsPlazas();
      renderAll();
    });
  }

  // Lee el JSON incrustado en el propio HTML (script#embedded-data).
  // Es el camino normal cuando el archivo se abre con doble clic (file://),
  // donde fetch() a data.json queda bloqueado por CORS.
  function loadEmbeddedData() {
    const el = document.getElementById("embedded-data");
    if (!el) return null;
    try {
      const parsed = JSON.parse(el.textContent);
      if (parsed && parsed.meses && parsed.meses.length) return parsed;
    } catch (e) { /* sin datos incrustados válidos */ }
    return null;
  }

  async function main() {
    try {
      const embedded = loadEmbeddedData();
      if (embedded) {
        G = embedded;
      } else {
        // Solo aplica si el dashboard se sirve por http(s); en file:// no se llega aquí.
        const resp = await fetch(`data.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        G = await resp.json();
      }
      document.getElementById("client-name").textContent = G.cliente.nombre_largo;
      document.getElementById("last-update").textContent = G.generado;
      document.getElementById("rango-fechas").textContent = `${G.rango.desde} → ${G.rango.hasta}`;
      document.title = `Dashboard de Eventos — ${G.cliente.nombre_corto}`;
      initFilterControls();
      renderAll();
      setTimeout(() => document.getElementById("loading").classList.add("hidden"), 150);
    } catch (err) {
      console.error(err);
      document.getElementById("error-detail").textContent = err.message;
      document.getElementById("error-banner").hidden = false;
      document.getElementById("loading").classList.add("hidden");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();

})();
