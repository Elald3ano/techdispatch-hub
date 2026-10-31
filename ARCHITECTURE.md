# MillaOps Hub — Dossier de Control Arquitectónico

> **Autor:** Daniel Córdoba — Asistente Técnico Distrital · GitHub: [@elald3ano](https://github.com/elald3ano)
>
> **Subtítulo oficial:** *Seguimiento de Servicios Última Milla*.
> Documento de referencia del estado **real** del software, generado por inspección directa del
> código y verificación de la base de datos en Supabase.
>
> **Fecha de control:** 28 de octubre de 2026 · **Cierre formal de Fase 1**
> **Stack:** React 19.3 · TypeScript ~6.0 · Vite 8.3 · Tailwind CSS v4.3 · Supabase JS 2.118
>
> Este dossier es la fuente de verdad para cualquier capa de negocio nueva. Toda lógica adicional
> debe respetar las **3 invariantes** descritas al final (sección 4).

---

## 1. Modelo de Datos y Estado en Supabase

### 1.1 Tablas vivas y esquemas

El esquema se define en `supabase/schema.sql` (script idempotente) y se amplía con migraciones
incrementales en `supabase/migration_*.sql`.

#### `tecnicos` — Técnicos disponibles para asignación

| Columna     | Tipo         | Restricciones                          |
|-------------|--------------|----------------------------------------|
| `id`        | UUID         | PK, `gen_random_uuid()`                 |
| `nombre`    | TEXT         | NOT NULL                                |
| `telefono`  | TEXT         | nullable                                |
| `activo`    | BOOLEAN      | NOT NULL DEFAULT `TRUE`                 |
| `created_at`| TIMESTAMPTZ  | NOT NULL DEFAULT `now()`                |

- Índice único `idx_tecnicos_nombre ON tecnicos (nombre)` (creado por el seed, garantiza que
  `asegurarTecnicos` no duplique técnicos por nombre).

#### `reglas_asignacion` — Matriz de asignación (ciudad/barrio/servicio → técnico)

| Columna         | Tipo        | Restricciones                                        |
|-----------------|-------------|------------------------------------------------------|
| `id`            | UUID        | PK, `gen_random_uuid()`                              |
| `tecnico_id`    | UUID        | FK → `tecnicos(id)` **ON DELETE CASCADE**            |
| `ciudad`        | TEXT        | NOT NULL                                             |
| `barrio`        | TEXT        | nullable                                             |
| `tipo_servicio` | TEXT        | nullable                                             |
| `prioridad`     | INTEGER     | NOT NULL DEFAULT `1` (1=Ciudad+Barrio+Servicio · 2=Ciudad+Barrio · 3=Solo Ciudad [obsoleto]) |
| `created_at`    | TIMESTAMPTZ | NOT NULL DEFAULT `now()`                             |

Índices relevantes:

- `idx_reglas_busqueda ON reglas_asignacion (ciudad, barrio, tipo_servicio)` — búsqueda en matriz.
- `idx_reglas_unica ON reglas_asignacion (tecnico_id, ciudad, COALESCE(barrio,''), COALESCE(tipo_servicio,''))`
  — índice único de **idempotencia** del seed (`supabase/seed_matriz_completa.sql`).
- `idx_regla_especialidad_unica ON reglas_asignacion (ciudad, barrio, COALESCE(tipo_servicio, ''))`
  — índice único que materializa la **coexistencia jerárquica**: solo una regla general
  (`tipo_servicio = NULL → ''`) por `(ciudad, barrio)`, y una regla flotante por cada
  `(ciudad, barrio, tipo_servicio)`. ⚠️ **Migración pendiente**
  (`supabase/migration_flotantes.sql`), que además elimina el índice obsoleto
  `idx_regla_ciudad_barrio_unica`. Requiere ejecutarse en el SQL Editor de Supabase.

#### `lotes_carga` — Lotes/cortes de importación

| Columna          | Tipo        | Restricciones                        |
|------------------|-------------|--------------------------------------|
| `id`             | UUID        | PK, `gen_random_uuid()`              |
| `nombre`         | TEXT        | NOT NULL                             |
| `fecha_corte`    | TIMESTAMPTZ | NOT NULL                             |
| `es_linea_base`  | BOOLEAN     | NOT NULL DEFAULT `FALSE`             |
| `total_servicios`| INTEGER     | NOT NULL DEFAULT `0`                 |
| `created_at`     | TIMESTAMPTZ | NOT NULL DEFAULT `now()`             |

- Índice único parcial `idx_unico_lote_linea_base ON lotes_carga (es_linea_base) WHERE es_linea_base = TRUE`
  — garantiza que exista **un solo despacho activo** a la vez. Es la tabla que identifica el
  "despacho en vivo": `getServiciosActivos()` filtra `es_linea_base = TRUE`.

#### `servicios` — Órdenes importadas por lote

| Columna            | Tipo        | Restricciones                                        |
|--------------------|-------------|------------------------------------------------------|
| `id`               | UUID        | PK, `gen_random_uuid()`                              |
| `lote_id`          | UUID        | FK → `lotes_carga(id)` **ON DELETE CASCADE**         |
| `numero_orden`     | TEXT        | NOT NULL  (columna Sigma "Servicio")                 |
| `ciudad`           | TEXT        | NOT NULL  (columna Sigma "Sucursal")                 |
| `barrio`           | TEXT        | NOT NULL  (columna Sigma "Barrio")                   |
| `direccion`        | TEXT        | nullable  (columna Sigma "Dirección")                |
| `tipo_servicio`    | TEXT        | NOT NULL  (columna Sigma "Tipo de solicitud")        |
| `nombre_cliente`   | TEXT        | nullable  (columna Sigma "Nombre")                   |
| `telefono_cliente` | TEXT        | nullable  (columna Sigma "Teléfono")                 |
| `referencia_pago`  | TEXT        | nullable  (columna Sigma "Referencia de pago")       |
| `identificacion`   | TEXT        | nullable  (columna Sigma "Identificación")           |
| `estado_sigma`     | TEXT        | nullable  (columna Sigma "Estado en Sigma")          |
| `fecha_creacion`   | TIMESTAMPTZ | NOT NULL  (columna Sigma "Fecha de creación")        |
| `dias_antiguedad`  | INTEGER     | NOT NULL DEFAULT `0` (columna Sigma "Días abierta")  |
| `tecnico_id`       | UUID        | FK → `tecnicos(id)` **ON DELETE SET NULL**           |
| `estado`           | TEXT        | NOT NULL DEFAULT `'ABIERTO'` CHECK (`ABIERTO`/`CERRADO`) |
| `created_at`       | TIMESTAMPTZ | NOT NULL DEFAULT `now()`                             |

- Los campos del cliente (`nombre_cliente`, `telefono_cliente`, `referencia_pago`,
  `identificacion`, `estado_sigma`) se agregan con la migración `migration_sigma_fields.sql`.

Índices:

- `idx_servicios_numero_orden ON servicios (numero_orden)` — diff de órdenes.
- `idx_servicios_lote_estado ON servicios (lote_id, estado)` — filtrado por lote/estado.
- `idx_servicios_tecnico_id ON servicios (tecnico_id)` — asignación por técnico.

#### `tecnicos_ciudades` — Ciudades activas por técnico (Gestión Territorial)

| Columna     | Tipo        | Restricciones                                    |
|-------------|-------------|--------------------------------------------------|
| `id`        | UUID        | PK, `gen_random_uuid()`                          |
| `tecnico_id`| UUID        | FK → `tecnicos(id)` **ON DELETE CASCADE**        |
| `ciudad`    | TEXT        | NOT NULL                                         |
| `created_at`| TIMESTAMPTZ | NOT NULL DEFAULT `now()`                         |

- `CONSTRAINT uq_tecnico_ciudad UNIQUE (tecnico_id, ciudad)`.
- Índice `idx_tecnicos_ciudades_tecnico ON tecnicos_ciudades (tecnico_id)`.
- ⚠️ **Migración pendiente** (`supabase/migration_tecnicos_ciudades.sql`). El servicio
  `getCiudadesActivas()` la lee de forma defensiva: si la tabla no existe, devuelve `{}` y
  registra un `console.warn`, sin romper la carga inicial.

#### Políticas RLS (Row Level Security)

Modelo **permisivo** (SPA estática consumida desde GitHub Pages): todas las tablas habilitan RLS
con políticas `FOR ALL TO anon, authenticated USING (TRUE) WITH CHECK (TRUE)`. Es un entorno
operativo interno; no hay restricciones de fila por rol.

### 1.2 Datos Maestros Actuales

> Verificado contra la base de datos en vivo el 27/10/2026.

| Entidad                     | Cantidad | Nota                                                        |
|-----------------------------|----------|-------------------------------------------------------------|
| Técnicos (total)            | **33**   | 30 operativos (seed) + 3 demo (`schema.sql`), todos `activo`|
| Técnicos activos            | **33**   | `activo = TRUE`                                             |
| Reglas de asignación        | **913**  | 912 `prioridad 2` (general) + 1 `prioridad 3` (ciudad, obsoleta); sin reglas flotantes (P1) aún |
| Servicios en despacho activo| **880**  | lote `es_linea_base = TRUE`, ya depurados a la lista blanca  |
| └ Asignados a técnico       | **834**  | `tecnico_id IS NOT NULL`                                    |
| └ Sin asignar               | **46**   | huérfanos pendientes de matriz/cobertura                    |

---

## 2. Motor de Ingesta y Reglas de Negocio Territoriales

### 2.1 Filtro de Jurisdicción — `src/lib/zonasPermitidas.ts`

Define la **lista blanca operativa** de 27 sucursales autorizadas (constante
`SUCURSALES_AUTORIZADAS`):

```
Zarzal, Yumbo, Villa Gorgona, Tulua, Toro Valle, Todos los Santos, Sonso,
Santander de Quilichao, Puerto Tejada, Presidente Valle, Palmira, Miranda,
Jamundi, Guacari, Florida, Chancos, Cerrito, Carmelo, Candelaria, Caloto,
Cali, La Union, La Paila, Bugalagrande, Buga, BuenaVentura, Andalucia
```

Mecánica:

1. Se precalcula un `Set` de las sucursales normalizadas con `limpiarTexto` (búsqueda O(1)).
2. Un mapa `ALIASES` resuelve variantes de nombre que llegan del sistema origen (Sigma) hacia su
   forma canónica:

   | Alias (llegada)     | Canónico         |
   |---------------------|------------------|
   | `Toro`              | `Toro Valle`     |
   | `Presidente`        | `Presidente Valle` |
   | `Los Mangos - Cali` | `Cali`           |
   | `Los Mangos`        | `Cali`           |
   | `La Unión` / `Unión` / `Unión Valle` | `La Union` |
   | `La Paila Valle`    | `La Paila`       |

3. `esSucursalAutorizada(ciudad)` devuelve `true` solo si `limpiarTexto(ciudad)` está en el set
   directamente **o** vía alias. Cualquier ciudad ajena (Pereira, Dosquebradas, Manizales,
   Calarca, Medellín, Bogotá, etc.) devuelve `false` y se descarta.

La lista blanca se aplica **exclusivamente a `servicios`** (en el parser y en
`getServiciosActivos`). La matriz `reglas_asignacion` puede conservar entradas de ciudades fuera
de la lista blanca (históricas), sin efecto operativo porque el cruce de servicios nunca las
producirá.

### 2.2 Parser de Excel — `src/services/excelParser.ts`

`parseServiciosExcel(file, ciudadFiltro?)` lee un reporte Sigma (`.xlsx`/`.xls`) y produce
`ServicioNuevo[]` (estado `ABIERTO`, `tecnico_id: null`). Pipeline:

1. **Selección de hoja** — prioriza la pestaña cuyo nombre contenga `"servicio"`; si no, la
   primera hoja con datos tabulares.
2. **Mapeo de encabezados** — normaliza cada encabezado (`normalizarClave`: NFD → sin tildes →
   minúsculas → `[^a-z0-9]`) y lo mapea a campos del dominio. Sinónimos clave:

   | Campo `Servicio`      | Encabezados Sigma aceptados                      |
   |-----------------------|--------------------------------------------------|
   | `numero_orden`        | Servicio, Orden, Nro orden, Numero orden, No orden |
   | `ciudad`              | Sucursal, Ciudad, Municipio                      |
   | `tipo_servicio`       | Tipo de solicitud, Solicitud, Item, Trabajo      |
   | `barrio`              | Barrio, Sector                                   |
   | `direccion`           | Dirección, Dir                                   |
   | `nombre_cliente`      | Nombre, Cliente                                  |
   | `telefono_cliente`    | Teléfono, Celular                                |
   | `referencia_pago`     | Referencia de pago, Referencia                   |
   | `identificacion`      | Identificación, Cédula                           |
   | `estado_sigma`        | Estado en Sigma, Estado                          |
   | `dias_antiguedad`     | Días abierta, Antigüedad                         |
   | `fecha_creacion`      | Fecha de creación (y variantes)                  |

   Columnas requeridas: `numero_orden`, `ciudad`, `barrio`, `tipo_servicio`, `fecha_creacion`.
3. **Descarte por jurisdicción** — filas con `!esSucursalAutorizada(ciudad)` se descartan
   (contador `descartadas`). También se descartan filas sin `numero_orden`/`ciudad`/`barrio`/
   `tipo_servicio` o sin fecha válida.
4. **Antigüedad** — lee `dias_antiguedad` directo si es numérico; si no, calcula
   `differenceInCalendarDays(hoy, fecha_creacion)`.
5. **Log de auditoría** — `[Parser] Órdenes leídas de tu zona: N | Descartadas de otras zonas: M`.

`parsearMatrizExcel(file)` (importación masiva de la matriz) es análogo: mapea `sucursal`,
`barrio`, `tecnico` (y opcional `tipo_servicio`), descarta filas sin técnico.

### 2.3 Normalizador y Motor de Asignación

#### `limpiarTexto` — `src/lib/normalizer.ts` (fuente única de verdad)

```
lowercase → normalize('NFD') → quitar tildes [\u0300-\u036f] → [^a-z0-9] → trim
```

Solo conserva letras minúsculas y números, sin espacios ni símbolos. Es **determinista y
biyectiva en la práctica**: dos cadenas equivalentes producen la misma clave. Preserva códigos de
zona legítimos (`"C1"` → `"c1"`), a diferencia de las variantes antiguas que sobre-limpaban.

#### `limpiarBarrio` y `limpiarPrefijoNodo` — fusión de nodos comerciales

`limpiarPrefijoNodo(barrio)` elimina el prefijo de nodo comercial de Sigma (1–4 letras + guion
opcional + 1–3 dígitos + separador): `"JAMD-01 VILLA TATIANA"` → `"VILLA TATIANA"`,
`"BV06 - El Jardin"` → `"El Jardin"`. Un barrio sin prefijo de nodo queda intacto
(`"12 DE OCTUBRE"`).

`limpiarBarrio(barrio)` = `limpiarTexto(limpiarPrefijoNodo(barrio))` **fusiona variantes de nodo
dentro de la misma ciudad**: `"JAMD-01 VILLA TATIANA"` y `"JAMD-02 Villa Tatiana"` producen la misma
clave `"villatatiana"`. No viola el namespace geográfico porque la **ciudad sigue siendo el prefijo
obligatorio** de la clave (`limpiarTexto(ciudad)|…`), impidiendo cruces entre municipios.

#### Motor de cascada — `src/services/assignmentEngine.ts`

`aplicarMatrizAsignacion(servicios, reglas)` construye dos mapas y resuelve en orden estricto
(primera coincidencia gana):

| Prioridad | Clave de cruce                                          | Requisito de regla          | Resultado                  |
|-----------|---------------------------------------------------------|-----------------------------|----------------------------|
| **P1**    | `${limpiarTexto(ciudad)}\|${limpiarBarrio(barrio)}\|${limpiarTexto(servicio)}` | `barrio` **y** `tipo_servicio` no nulos | Técnico **Flotante** |
| **P2**    | `${limpiarTexto(ciudad)}\|${limpiarBarrio(barrio)}`      | `barrio` no nulo            | Técnico **General / Carro** |
| *(fallback)* | —                                                     | —                           | `null` (**sin asignar**)   |

- La fórmula exacta de la clave de barrio es `` `${limpiarTexto(ciudad)}|${limpiarBarrio(barrio)}` ``.
- El resultado preserva el orden entrada → salida y emite el log
  `[Motor] Procesados: N | Asignados: X | Sin Asignar: Y`.
- El antiguo fallback **Prioridad 3 (solo ciudad)** fue eliminado: una orden sin dueño de barrio
  ni servicio específico queda explícitamente **sin asignar**, nunca absorbida por una regla
  genérica de ciudad.
- `calcularPrioridad(ciudad, barrio?, tipoServicio?)`: `1` si tiene los tres, `2` si ciudad+barrio,
  `3` si solo ciudad (valor que el motor ya ignora; se conserva por compatibilidad de esquema).

#### Regla de negocio: Coexistencia Jerárquica (General + Flotante)

El modelo actual permite que un barrio conviva entre:

- **1 Técnico Territorial General (Carro)** — regla `prioridad = 2`, `tipo_servicio = NULL`.
- **N Técnicos Flotantes (Moto)** — una regla `prioridad = 1` por cada `tipo_servicio` específico.

La cascada P1 → P2 garantiza que, cuando existe un flotante para un servicio concreto, **intercepta**
la orden antes de que la tome el dueño territorial general.

`asignarCuadrilla(tecnicoId, ciudad, config)` (`src/services/supabaseService.ts`) materializa la
configuración:

1. Borra las reglas previas del técnico en esa ciudad (generales y flotantes).
2. Inserta las reglas nuevas: general → `prioridad = 2`, `tipo_servicio = null` por barrio;
   flotante → `prioridad = 1`, `tipo_servicio = nombre` por cada (barrio × servicio).
3. Re-aplica la matriz al despacho activo (`reasignarServiciosActivos`), que ahora **asigna y
   libera** órdenes según el resultado del cruce.

### 2.4 Lectura Paginada de Supabase — `leerTodasLasFilas`

`src/services/supabaseService.ts` expone `leerTodasLasFilas<T>()`, que pagina con `.range()` +
`.order('id')` y une todas las páginas. PostgREST trunca las respuestas a **1.000 filas** por
defecto; esta helper hace que `getReglas()`, `getServiciosActivos()`, `reasignarServiciosActivos()`
y `getCiudadesActivas()` sean **inmunes a ese límite**, evitando pérdida silenciosa de reglas
(como las cuadrillas flotantes de un técnico) y sub-asignación de órdenes.

### 2.5 Semáforo SLA — `src/lib/sla.ts`

Clasificación de antigüedad con **bloques sólidos** de alto impacto (Looker Studio):

| Nivel | Condición | Color |
|-------|-----------|-------|
| 🟢 verde (al día)  | `dias <= 1` | esmeralda sólido |
| 🟡 amarillo (atención) | `dias === 2` | amarillo intenso + texto oscuro |
| 🔴 rojo (crítico) | `dias >= 3` | carmesí sólido |

`esCritica(d) = d >= 3`. Alimenta el badge sólido de la tabla web (`ServiceTable`), el desglose de
la tarjeta "Semáforo SLA" (`MetricCards`) y el coloreado de celda en los PDF.

---

## 3. Arquitectura Frontend (React 19 + Tailwind v4)

### 3.1 Árbol de componentes y pestañas — `src/App.tsx`

`App` es el orquestador único. Conmuta entre dos vistas principales con `vistaActiva`:

- **Pestaña 1 — Despacho en Vivo** (`vistaActiva === 'despacho'`):
  `MetricCards` + `ServiceTable` (tabla) + `FileUpload` (ingesta de Excel).
- **Pestaña 2 — Gestión Territorial** (`vistaActiva === 'territorio'`):
  - sin técnico seleccionado → `DirectorioTecnicos`.
  - con técnico seleccionado (`tecnicoSeleccionadoId`) → `DetalleTecnicoTerritorio`.

**Estados globales compartidos** (levantados en `App`):

| Estado              | Tipo                                | Origen                                          |
|---------------------|-------------------------------------|-------------------------------------------------|
| `serviciosActivos`  | `Servicio[]`                        | `getServiciosActivos()` (lote línea base, whitelist) |
| `tecnicos`          | `Tecnico[]`                         | `getTecnicos()`                                 |
| `reglas`            | `ReglaConTecnico[]`                 | `getReglas()` (join con técnico)                |
| `ciudadesActivas`   | `Record<string, string[]>`          | `getCiudadesActivas()` (`tecnicos_ciudades`)    |
| `ciudadFiltrada`    | `string`                            | puente ServiceTable → PdfExportModal            |

Flujos de datos principales:

- **Ingesta** (`handleProcesar`): parsea Excel → `aplicarMatrizAsignacion` → `reemplazarServiciosActivos`
  (borra lote anterior y crea el nuevo) → `cargarDatos`.
- **Sincronización** (`handleSincronizar`): `reasignarServiciosActivos()` re-aplica la matriz a los
  servicios persistidos y devuelve cuántas órdenes cambiaron.
- **Reasignación manual** (`handleReasignar`): actualización optimista con rollback.
- **Re-aplicar matriz en pantalla** (`reaplicarMatriz`): cruza en memoria sin tocar Supabase.

Dos modales globales: `RulesManagerModal` (importación de matriz, se abre con "Gestionar Matriz") y
`PdfExportModal` ("Exportar PDF"). Toasts centralizados en `ToastContainer` vía `notificar`.

### 3.2 Módulo de Despacho — `src/components/ServiceTable.tsx`

#### Filtros multi-selección con buscador interno

Los selectores nativos de Ciudad, Técnico y Tipo de Servicio se reemplazaron por
**`MultiSelectFilter`** (`src/components/MultiSelectFilter.tsx`), un combobox de selección múltiple
con buscador integrado, acciones `[Marcar Todos]` / `[Limpiar]`, cierre por clic-afuera/Escape y
checkbox personalizado.

- Estado en **arrays**: `filtros.ciudades`, `filtros.tecnicos` (soporta `'sin_asignar'`),
  `filtros.servicios`; vacío = sin filtro (todas).
- Semántica de filtrado: **OR dentro de cada filtro** y **AND entre filtros** (helpers
  `coincideBusqueda` y `coincideTecnico`).
- **Inteligencia en cascada conservada**: `baseCiudad` / `baseTecnico` / `baseTipo` (cada uno
  excluye su propio filtro) alimentan `opcionesCiudad` / `opcionesTecnico` / `opcionesTipo` con
  conteos recalculados en vivo según las selecciones activas de los demás filtros. El SLA se aplica
  al final (para no vaciar los selectores en cascada).
- `"Sin Asignar"` agrupa `null`/`undefined`/`''`; el técnico se compara con `normalizarId`
  (tolerancia a espacios/case).

#### Ordenamiento interactivo

- Estado inicial: `{ columna: 'antiguedad', direccion: 'desc' }` (lo más viejo primero).
- `ordenados` ordena `filtrados` según la columna activa:
  `antiguedad` (numérico), `orden` (`localeCompare` con `numeric: true`), `ciudad`/`barrio`/
  `cliente`/`servicio`/`tecnico` (alfabético; técnico resuelve el nombre vía `nombrePorId`).
- Encabezados `ThOrdenable`: clic en la misma columna invierte `asc`/`desc`; en una columna nueva
  activa `asc` (o `desc` si es `antiguedad`). Iconos `ArrowUpDown` (tenue, inactiva) /
  `ArrowUp`-`ArrowDown` (azul marino, activa).

#### Exportación rápida táctica 1-clic

Botón **"Exportar esta vista"** (`FileDown`) en la barra de la tabla: exporta las órdenes **ya
filtradas y ordenadas** (`ordenados`, no solo la página) llamando a
`exportarVistaActualPdf(ordenados, tecnicos, metadata)`.

### 3.3 Módulo Territorial — `src/components/territorio/`

#### `DirectorioTecnicos.tsx` — Directorio maestro

Tabla oscura (navy) con búsqueda por nombre/ID y pestañas de filtro rápido (`Todos` /
`Con barrios asignados` / `Sin barrios`). Por técnico muestra ID corto (primeros 8 del UUID),
número de ciudades activas y número de barrios asignados (derivados de `reglas` y
`ciudadesActivas`). Un clic en la fila selecciona el técnico (`onSeleccionar`).

#### `DetalleTecnicoTerritorio.tsx` — Configurador de cuadrillas por ciudad

- **Switches de ciudades** ("Gestionar Ciudades"): modal con checkboxes que persisten la selección
  en `tecnicos_ciudades` vía `guardarCiudadesActivasTecnico` (optimista con `Set` local).
- **Selector de modalidad** por ciudad (toggle):
  - **Todos los servicios** (Cuadrilla General / Carro) → reglas `prioridad = 2`,
    `tipo_servicio = null`.
  - **Servicios específicos** (Cuadrilla Flotante / Moto) → una regla `prioridad = 1` por cada
    combinación (barrio × servicio).
- **Servicios específicos**: panel de selección con **buscador y filtro** sobre el catálogo oficial
  completo de **73 tipos de servicio** (`src/lib/tiposServicio.ts`, `TIPOS_SERVICIO_OFICIALES`), con
  botones "Marcar Todos"/"Desmarcar Todos", contador en vivo y una sección ámbar para servicios
  históricos fuera del catálogo.
- **Tablero de barrios**: chips toggle por barrio con botones **"Marcar Todos"** / **"Limpiar"**;
  los chips con dueño general ajeno (regla P2 de otro técnico) se resaltan en azul con un tooltip.
- **Guardado**: `guardarCuadrilla` llama a `asignarCuadrilla` (borra + inserta reglas y re-sincroniza
  el despacho) y refresca reglas/servicios en `App` vía `onCambio`.

### 3.4 Sistema de Reportes PDF — `pdfGenerator.ts` + `PdfExportModal.tsx`

#### Estructura unificada de 7 columnas

Ambos generadores comparten el mismo orden de columnas (alineación web ↔ PDF):

```
[Días, Orden #, Ciudad, Barrio / Dirección, Cliente / Tel / Ref, Tipo de Servicio, Técnico/Firma]
```

La **única** diferencia funcional está en la columna 7:

| Generador                          | Columna 7            | Uso                          |
|------------------------------------|----------------------|------------------------------|
| `generarPlanillaPdf` (masivo)      | `Firma Cliente` (vacía) | Hoja física de trabajo que el técnico firma |
| `exportarVistaActualPdf` (vista)   | `Técnico Asignado` (nombre real / "Sin Asignar") | Snapshot de lo que se ve en pantalla |

- La celda "Días" usa **bloque sólido de semáforo** (Looker Studio): 🟢 ≤1 día, 🟡 2 días, 🔴 ≥3 días
  (vía `colorearDiasSemaforo` en `didParseCell`).
- El "Cliente / Tel / Ref" es una celda de 3 líneas con **tipografía mixta** (nombre en negrita,
  teléfono/referencia en gris), redibujada con `willDrawCell`/`didDrawCell`.
- **`rowPageBreak: 'avoid'`** evita cortes de fila a mitad de página: una fila que no cabe completa
  se traslada íntegra a la página siguiente (el nombre y la referencia nunca quedan separados).
- Ambas dependencias pesadas (`jspdf`, `jspdf-autotable`) se cargan **dinámicamente** (chunks
  separados del bundle inicial). El pie de página firma
  `MillaOps Hub · Daniel Córdoba (Asistente Técnico Distrital) · Página i de N`.

#### Filtro funcional de ciudad en el modal consolidado

`PdfExportModal` convierte el antiguo campo de texto en un `<select>` que **filtra de verdad**:

- Opciones derivadas de los servicios reales (agrupadas por `limpiarTexto`) con su conteo:
  `Cali (120)`, `BuenaVentura (210)`, `Tulua (222)`, etc., más la opción
  `Todas las ciudades (Consolidado Regional)`.
- `serviciosDeCiudad` filtra con `limpiarTexto(s.ciudad) === limpiarTexto(ciudadSeleccionada)`.
- `grupos` (técnicos con órdenes en esa ciudad), `totalOrdenes`, `totalCriticas` y el **RESUMEN**
  (Técnico(s) / Órdenes / Críticas) se recalculan en tiempo real sobre ese subconjunto.
- La pestaña "Técnico específico" solo lista técnicos con órdenes en la ciudad elegida; si cambias
  de ciudad y el técnico ya no aplica, se limpia automáticamente.
- **Pre-llenado inteligente**: `App` pasa `ciudadInicial` (la ciudad filtrada en `ServiceTable`,
  vía `onCambioCiudadFiltrada`).

#### Regla de ordenamiento por SLA en planillas masivas

`generarPlanillaPdf` aplica la **REGLA DE ORO**: dentro de la planilla de cada técnico, las órdenes
se ordenan **obligatoriamente por `dias_antiguedad` descendente**, de modo que lo más crítico
aparece en el primer renglón de su hoja de trabajo.

---

## 4. Invariantes del Sistema (no negociables)

Cualquier capa de negocio nueva **debe** preservar estas tres invariantes. Romper una de ellas
introduce inconsistencia silenciosa entre ingesta, asignación, despacho y PDF.

1. **`limpiarTexto` es la única fuente de verdad de normalización.**
   Todo cruce geográfico (ciudad, barrio, servicio) usa `limpiarTexto` (`src/lib/normalizer.ts`).
   El barrio usa `limpiarBarrio` (= `limpiarTexto` tras quitar el prefijo de nodo comercial), que
   fusiona variantes de nodo dentro de la misma ciudad sin tocar el prefijo de ciudad. Está
   prohibido introducir una segunda función de normalización o comparar cadenas crudas en claves de
   asignación.

2. **La lista blanca de jurisdicción (27 sucursales) se aplica SIEMPRE en la ingesta.**
   Toda orden de una ciudad fuera de `SUCURSALES_AUTORIZADAS` se descarta en `parseServiciosExcel`
   y en `getServiciosActivos` vía `esSucursalAutorizada`. Ninguna zona ajena puede entrar al
   despacho, a las métricas ni a los PDF.

3. **Coexistencia Jerárquica: 1 Barrio tiene 1 Técnico Territorial General (P2) y puede tener
   Técnicos Flotantes asignados a tipos de servicio específicos (P1).**
   El cruce siempre evalúa **P1 (Flotante) → P2 (General) → null**. Nunca debe re-introducirse un
   fallback por ciudad (antigua P3) ni permitirse más de un dueño general por `(ciudad, barrio)`
   (lo garantiza el índice `idx_regla_especialidad_unica`).

---

### Mapa de archivos clave

```
src/
  App.tsx                            Orquestador: pestañas, estados globales, flujos
  lib/
    normalizer.ts                    limpiarTexto (invariante #1)
    zonasPermitidas.ts               lista blanca 27 + aliases (invariante #2)
    sla.ts                           semáforo SLA (≤1 verde · 2 amarillo · ≥3 rojo)
    tiposServicio.ts                 catálogo oficial de 73 tipos de servicio
    supabase.ts                      cliente Supabase + isSupabaseConfigured
    utils.ts                         cn()
  services/
    excelParser.ts                   ingesta Sigma + matriz Excel
    assignmentEngine.ts              cascada P1 (flotante) → P2 (general) + calcularPrioridad
    supabaseService.ts               operaciones de BD + asignarCuadrilla + leerTodasLasFilas
    pdfGenerator.ts                  generarPlanillaPdf + exportarVistaActualPdf (rowPageBreak: 'avoid')
  components/
    ServiceTable.tsx                 filtros multi-selección + orden + export 1-clic
    MultiSelectFilter.tsx            combobox multi-selección con buscador integrado
    PdfExportModal.tsx               modal consolidado con filtro de ciudad
    RulesManagerModal.tsx            importación de matriz
    territorio/
      DirectorioTecnicos.tsx         directorio maestro
      DetalleTecnicoTerritorio.tsx   configurador de cuadrillas (modalidad/servicios/barrios)
supabase/
  schema.sql                         esquema base + RLS + seed demo
  seed_matriz_completa.sql           30 técnicos + 879 reglas (idempotente)
  migration_sigma_fields.sql         columnas cliente del reporte Sigma
  migration_regla_unica.sql          ⚠️ reemplazada por migration_flotantes.sql (idx_regla_especialidad_unica)
  migration_flotantes.sql            ⚠️ pendiente: idx_regla_especialidad_unica (coexistencia P1/P2)
  migration_tecnicos_ciudades.sql    ⚠️ pendiente: tabla tecnicos_ciudades
```
