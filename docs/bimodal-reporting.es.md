# Reportes Bimodales — Técnico y Ejecutivo

Cada ejecución genera un reporte con **dos secciones para dos audiencias distintas**.

## Archivos por ejecución

```
results/YYYY-MM-DD_<tipo>_<servicio>/
  ├── <servicio>-report.html          ← k6-reporter (datos automáticos)
  ├── <servicio>-dashboard.html       ← k6 web dashboard export
  └── report-<TICKET>-YYYY-MM-DD.md  ← Análisis escrito (ambas secciones)
```

---

## Template del reporte `.md`

```markdown
# Reporte — <KEY-XX> · Tipo: Smoke / Load / Stress

## SECCIÓN EJECUTIVA (para Stakeholders / Negocio)

**Resumen:**
- Fecha: YYYY-MM-DD HH:MM
- Tipo de prueba: Smoke / Load / Stress / Spike / Soak
- Duración total: X minutos
- Usuarios virtuales: N VUs
- Tasa de error global: X%

**Resultados clave:**
- ✅ Throughput: X req/s
- ✅ P95 latency: Xms (SLA: <Yms)
- ✅ Error rate: X% (SLA: <Y%)
- ✅ Disponibilidad: 99.X%

**Veredicto:** Estable / Degradación menor / Degradación crítica

**Impacto en Black Friday:**
- [¿El servicio aguanta el tráfico esperado?]
- [¿Hay riesgo de caída bajo pico de demanda?]

---

## SECCIÓN TÉCNICA (para QA / Performance Engineer)

### Configuración del test
- Executor: ramping-vus / constant-arrival-rate
- Ramp-up: X min → peak: Y VUs × Z min → ramp-down: X min
- Endpoint base: http://localhost:300X
- Dataset: N registros en data/users.json

### SLAs y Thresholds
| Métrica | Target | Resultado | Estado |
|---|---|---|---|
| p(95) latency | <Xms | Yms | ✅/❌ |
| p(99) latency | <Xms | Yms | ✅/❌ |
| error rate | <X% | Y% | ✅/❌ |

### Bottlenecks detectados
- [Endpoint con mayor latencia]
- [Tipo de error más frecuente]
- [Comportamiento bajo ramp-up vs peak]

### Recomendaciones
- [Optimizaciones sugeridas]
- [Próximas pruebas recomendadas]
```

---

## Workflow: ejecución → reporte → JIRA

1. Ejecutar k6 → el script genera `results/` automáticamente (Block 5)
2. Leer el HTML generado para entender resultados
3. Crear el `.md` de análisis con ambas secciones
4. Si tienes MCP de JIRA conectado: comentar en el ticket con la sección ejecutiva
5. Commit en git:
   ```bash
   git add results/YYYY-MM-DD_<tipo>_<servicio>/
   git commit -m "perf: add <tipo> test results — PERF-XX"
   ```

---

## Interpretación rápida de métricas k6

| Métrica | Qué significa |
|---|---|
| `http_req_duration p(95)` | 95% de requests completaron en ≤ X ms |
| `http_req_failed rate` | % de requests con error (status ≥ 400 o red failure) |
| `http_reqs` | Total de requests enviadas |
| `iterations` | Total de veces que ejecutó la función `default` |
| `vus_max` | Pico de VUs concurrentes alcanzado |
| `data_received` | Total de datos recibidos del servidor |
