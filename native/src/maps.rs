//! Declarative RPM/absolute-pressure maps. No engine data are inferred from audio.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalibrationKind {
    Ve,
    IndicatedEfficiency,
    Fmep,
}
impl CalibrationKind {
    fn spec(self) -> (&'static str, f64, f64) {
        match self {
            Self::Ve => ("fraction", 0.2, 1.3),
            Self::IndicatedEfficiency => ("fraction", 0.05, 1.0),
            Self::Fmep => ("bar", 0.0, 5.0),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ve => "ve",
            Self::IndicatedEfficiency => "indicatedEfficiency",
            Self::Fmep => "fmep",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationValidation {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub independent: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationProvenance {
    pub source: String,
    pub label: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calibrated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation: Option<CalibrationValidation>,
}
impl Default for CalibrationProvenance {
    fn default() -> Self {
        Self {
            source: "assumed".into(),
            label: "Hipóteses de demonstração".into(),
            version: "original-demo-1".into(),
            engine_id: None,
            notes: None,
            calibrated_at: None,
            validation: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AxisUnits {
    pub rpm: String,
    pub pressure: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationMap {
    pub schema: String,
    pub kind: CalibrationKind,
    pub rpm: Vec<f64>,
    pub pressure_bar: Vec<f64>,
    pub values: Vec<Vec<f64>>,
    pub axis_units: AxisUnits,
    pub value_unit: String,
    pub provenance: CalibrationProvenance,
    pub extrapolation: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationSample {
    pub value: f64,
    pub extrapolated: bool,
    pub extrapolated_axes: Vec<String>,
    pub clamped_rpm: f64,
    pub clamped_pressure_bar: f64,
    pub source: String,
    pub map_label: String,
    pub provenance: CalibrationProvenance,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationBundle {
    pub schema: String,
    pub maps: BTreeMap<CalibrationKind, CalibrationMap>,
}
fn fail(message: &str) -> String {
    format!("Mapa de calibração: {message}")
}
fn trimmed(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
fn text(
    input: Option<&Value>,
    name: &str,
    max: usize,
    optional: bool,
) -> Result<Option<String>, String> {
    if input.is_none() && optional {
        return Ok(None);
    }
    let s = input
        .and_then(Value::as_str)
        .ok_or_else(|| fail(&format!("{name} inválido.")))?;
    if trimmed(s).is_empty()
        || s.encode_utf16().count() > max
        || s.chars()
            .any(|c| c <= '\u{001f}' && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err(fail(&format!("{name} inválido.")));
    }
    Ok(Some(trimmed(s).to_owned()))
}
// JSON provenance accepts the ISO date/time shapes used by the TS contract.
// Date-only overflow days (up to31) retain JavaScript Date.parse semantics.
pub fn valid_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 10
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || bytes[4] != b'-'
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || bytes[7] != b'-'
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let month = s[5..7].parse::<u32>().unwrap_or(0);
    let day = s[8..10].parse::<u32>().unwrap_or(0);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    if bytes.len() == 10 {
        return true;
    }
    if bytes[10] != b'T' {
        return false;
    }
    let mut time = &s[11..];
    if let Some(x) = time.strip_suffix('Z') {
        time = x;
    } else if let Some(at) = time
        .char_indices()
        .find_map(|(i, c)| if c == '+' || c == '-' { Some(i) } else { None })
    {
        let zone = &time[at + 1..];
        let mut p = zone.split(':');
        let (h, m) = (p.next().unwrap_or(""), p.next().unwrap_or(""));
        if p.next().is_some()
            || h.len() != 2
            || m.len() != 2
            || h.parse::<u32>().map_or(true, |x| x > 23)
            || m.parse::<u32>().map_or(true, |x| x > 59)
        {
            return false;
        }
        time = &time[..at];
    }
    let p: Vec<&str> = time.split(':').collect();
    if p.len() < 2 || p.len() > 3 || p[0].len() != 2 || p[1].len() != 2 {
        return false;
    }
    let h = p[0].parse::<u32>().unwrap_or(99);
    let m = p[1].parse::<u32>().unwrap_or(99);
    let sec = if p.len() == 3 {
        let mut parts = p[2].split('.');
        let whole = parts.next().unwrap_or("");
        let fraction = parts.next();
        if whole.len() != 2
            || !whole.bytes().all(|b| b.is_ascii_digit())
            || fraction.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()))
            || parts.next().is_some()
        {
            return false;
        }
        p[2].parse::<f64>().unwrap_or(f64::NAN)
    } else {
        0.0
    };
    h <= 24
        && m <= 59
        && sec.is_finite()
        && (0.0..60.0).contains(&sec)
        && (h < 24 || (m == 0 && sec == 0.0))
}
fn date(v: Option<&Value>, name: &str) -> Result<Option<String>, String> {
    let Some(v) = v else { return Ok(None) };
    let s = v
        .as_str()
        .filter(|s| valid_date(s))
        .ok_or_else(|| fail(&format!("{name} inválida.")))?;
    Ok(Some(s.into()))
}
fn axis(v: Option<&Value>, name: &str, lo: f64, hi: f64) -> Result<Vec<f64>, String> {
    let a = v
        .and_then(Value::as_array)
        .filter(|a| (2..=32).contains(&a.len()))
        .ok_or_else(|| fail(&format!("{name} precisa de 2 a 32 pontos.")))?;
    let mut result = Vec::with_capacity(a.len());
    for v in a {
        let n = v
            .as_f64()
            .filter(|n| n.is_finite() && *n >= lo && *n <= hi)
            .ok_or_else(|| fail(&format!("{name} contém valor inválido.")))?;
        if result.last().is_some_and(|previous| n <= *previous) {
            return Err(fail(&format!(
                "{name} precisa ser estritamente crescente, sem duplicatas."
            )));
        }
        result.push(n);
    }
    Ok(result)
}
pub fn normalize_provenance(input: &Value) -> Result<CalibrationProvenance, String> {
    let o = input
        .as_object()
        .ok_or_else(|| fail("origem precisa ser assumed, fitted ou measured."))?;
    let source = o
        .get("source")
        .and_then(Value::as_str)
        .filter(|s| matches!(*s, "assumed" | "fitted" | "measured"))
        .ok_or_else(|| fail("origem precisa ser assumed, fitted ou measured."))?;
    let notes = if let Some(n) = o.get("notes") {
        let s = n
            .as_str()
            .filter(|s| s.encode_utf16().count() <= 2000)
            .ok_or_else(|| fail("anotações inválidas."))?;
        Some(trimmed(s).into())
    } else {
        None
    };
    let validation = if let Some(v) = o.get("validation") {
        let obj = v
            .as_object()
            .ok_or_else(|| fail("validação precisa declarar independent como booleano."))?;
        Some(CalibrationValidation {
            label: text(obj.get("label"), "descrição da validação", 200, false)?.unwrap(),
            date: date(obj.get("date"), "data de validação")?,
            independent: obj
                .get("independent")
                .and_then(Value::as_bool)
                .ok_or_else(|| fail("validação precisa declarar independent como booleano."))?,
        })
    } else {
        None
    };
    Ok(CalibrationProvenance {
        source: source.into(),
        label: text(o.get("label"), "nome da origem", 160, false)?.unwrap(),
        version: text(o.get("version"), "versão", 60, false)?.unwrap(),
        engine_id: text(o.get("engineId"), "identificador do motor", 120, true)?,
        notes,
        calibrated_at: date(o.get("calibratedAt"), "data de calibração")?,
        validation,
    })
}
pub fn normalize_calibration_map(
    input: &Value,
    kind: CalibrationKind,
) -> Result<CalibrationMap, String> {
    let o = input
        .as_object()
        .ok_or_else(|| fail("objeto ausente ou inválido."))?;
    if o.get("schema").and_then(Value::as_str) != Some("carlab-calibration-map-1")
        || o.get("kind").and_then(Value::as_str) != Some(kind.as_str())
    {
        return Err(fail("formato ou grandeza incompatível."));
    }
    let units = o
        .get("axisUnits")
        .and_then(Value::as_object)
        .ok_or_else(|| fail("use eixos rpm e bar-absolute."))?;
    if units.get("rpm").and_then(Value::as_str) != Some("rpm")
        || units.get("pressure").and_then(Value::as_str) != Some("bar-absolute")
    {
        return Err(fail("use eixos rpm e bar-absolute."));
    }
    let (unit, min, max) = kind.spec();
    if o.get("valueUnit").and_then(Value::as_str) != Some(unit)
        || o.get("extrapolation").and_then(Value::as_str) != Some("clamp")
    {
        return Err(fail("unidade ou política de extrapolação incompatível."));
    }
    let rpm = axis(o.get("rpm"), "RPM", 0.0, 22000.0)?;
    let pressure_bar = axis(o.get("pressureBar"), "pressão absoluta em bar", 0.05, 8.0)?;
    let rows = o
        .get("values")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() == rpm.len())
        .ok_or_else(|| fail("número de linhas diferente do eixo RPM."))?;
    let mut values = Vec::with_capacity(rows.len());
    for row in rows {
        let row = row
            .as_array()
            .filter(|r| r.len() == pressure_bar.len())
            .ok_or_else(|| fail("cada linha deve cobrir todo o eixo de pressão."))?;
        let mut out = Vec::with_capacity(row.len());
        for value in row {
            let n = value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= min && *n <= max)
                .ok_or_else(|| {
                    fail(&format!(
                        "valores de {} devem estar entre {min} e {max} {unit}.",
                        kind.as_str()
                    ))
                })?;
            out.push(n);
        }
        values.push(out);
    }
    Ok(CalibrationMap {
        schema: "carlab-calibration-map-1".into(),
        kind,
        rpm,
        pressure_bar,
        values,
        axis_units: AxisUnits {
            rpm: "rpm".into(),
            pressure: "bar-absolute".into(),
        },
        value_unit: unit.into(),
        provenance: normalize_provenance(o.get("provenance").unwrap_or(&Value::Null))?,
        extrapolation: "clamp".into(),
    })
}
fn bracket(axis: &[f64], value: f64) -> (usize, usize, f64) {
    let (mut low, mut high) = (0, axis.len() - 1);
    while high - low > 1 {
        let middle = (low + high) >> 1;
        if axis[middle] <= value {
            low = middle;
        } else {
            high = middle;
        }
    }
    (low, high, (value - axis[low]) / (axis[high] - axis[low]))
}
pub fn sample_calibration_map(
    map: &CalibrationMap,
    rpm: f64,
    pressure_bar: f64,
) -> Result<CalibrationSample, String> {
    if !rpm.is_finite() || !pressure_bar.is_finite() {
        return Err(fail("consulta precisa de RPM e pressão finitos."));
    }
    if map.rpm.len() < 2 || map.pressure_bar.len() < 2 {
        return Err(fail("normalize o mapa antes da consulta."));
    }
    let cr = rpm.max(map.rpm[0]).min(*map.rpm.last().unwrap());
    let cp = pressure_bar
        .max(map.pressure_bar[0])
        .min(*map.pressure_bar.last().unwrap());
    let (r0, r1, rt) = bracket(&map.rpm, cr);
    let (p0, p1, pt) = bracket(&map.pressure_bar, cp);
    let at = |r: usize, p: usize| {
        map.values
            .get(r)
            .and_then(|row| row.get(p))
            .copied()
            .unwrap_or(f64::NAN)
    };
    let (a, b, c, d) = (at(r0, p0), at(r0, p1), at(r1, p0), at(r1, p1));
    if ![a, b, c, d, rt, pt].iter().all(|x| x.is_finite()) {
        return Err(fail("grade inválida; normalize o mapa antes da consulta."));
    }
    let value = (a + (b - a) * pt) * (1.0 - rt) + (c + (d - c) * pt) * rt;
    let mut extrapolated_axes = vec![];
    if cr != rpm {
        extrapolated_axes.push("rpm".into());
    }
    if cp != pressure_bar {
        extrapolated_axes.push("pressure".into());
    }
    Ok(CalibrationSample {
        value,
        extrapolated: !extrapolated_axes.is_empty(),
        extrapolated_axes,
        clamped_rpm: cr,
        clamped_pressure_bar: cp,
        source: map.provenance.source.clone(),
        map_label: map.provenance.label.clone(),
        provenance: map.provenance.clone(),
    })
}
pub fn create_assumed_ve_map(
    idle_rpm: f64,
    redline_rpm: f64,
    base_ve: f64,
    uniform: bool,
) -> Result<CalibrationMap, String> {
    if !idle_rpm.is_finite()
        || !redline_rpm.is_finite()
        || idle_rpm < 0.0
        || redline_rpm <= idle_rpm
        || redline_rpm > 22000.0
    {
        return Err(fail("faixa de giro para mapa assumido inválida."));
    }
    let base = if base_ve.is_finite() {
        base_ve.clamp(0.2, 1.3)
    } else {
        0.9
    };
    let rpm = vec![
        idle_rpm,
        idle_rpm + (redline_rpm - idle_rpm) * 0.3,
        idle_rpm + (redline_rpm - idle_rpm) * 0.6,
        redline_rpm,
    ];
    let pressure_bar = vec![0.15, 0.5, 1.0, 2.0, 4.0];
    let speed = [0.8, 0.95, 1.0, 0.84];
    let pressure = [0.9, 0.96, 1.0, 1.015, 1.02];
    let values: Vec<Vec<f64>> = speed
        .iter()
        .map(|r| {
            pressure
                .iter()
                .map(|p| {
                    if uniform {
                        base
                    } else {
                        (base * r * p).clamp(0.2, 1.3)
                    }
                })
                .collect()
        })
        .collect();
    normalize_calibration_map(
        &json!({"schema":"carlab-calibration-map-1","kind":"ve","rpm":rpm,"pressureBar":pressure_bar,"values":values,"axisUnits":{"rpm":"rpm","pressure":"bar-absolute"},"valueUnit":"fraction","extrapolation":"clamp","provenance":{"source":"assumed","label":if uniform{"Hipótese uniforme de enchimento"}else{"Hipótese genérica de enchimento por RPM e MAP"},"version":"original-demo-1","engineId":"generic-four-stroke","notes":"Curva original de demonstração, sem dados medidos ou ajustados. Não prevê efeitos de geometria, comando ou ressonância."}}),
        CalibrationKind::Ve,
    )
}
pub fn calibration_snapshot(
    maps: &BTreeMap<CalibrationKind, CalibrationMap>,
) -> Result<CalibrationBundle, String> {
    let mut normalized = BTreeMap::new();
    for (kind, map) in maps {
        normalized.insert(
            *kind,
            normalize_calibration_map(
                &serde_json::to_value(map).map_err(|e| e.to_string())?,
                *kind,
            )?,
        );
    }
    Ok(CalibrationBundle {
        schema: "carlab-calibration-bundle-1".into(),
        maps: normalized,
    })
}
pub fn parse_calibration_bundle(input: &Value) -> Result<CalibrationBundle, String> {
    let parsed;
    if let Some(s) = input.as_str() {
        if s.encode_utf16().count() > 200000 {
            return Err(fail("arquivo de mapas grande demais."));
        }
        parsed = serde_json::from_str::<Value>(s).map_err(|_| fail("JSON inválido."))?;
    } else {
        parsed = input.clone();
    }
    let obj = parsed
        .as_object()
        .ok_or_else(|| fail("pacote precisa de formato carlab-calibration-bundle-1."))?;
    if obj.get("schema").and_then(Value::as_str) != Some("carlab-calibration-bundle-1") {
        return Err(fail("pacote precisa de formato carlab-calibration-bundle-1."));
    }
    let raw = obj
        .get("maps")
        .and_then(Value::as_object)
        .ok_or_else(|| fail("pacote precisa de formato carlab-calibration-bundle-1."))?;
    let mut maps = BTreeMap::new();
    for (key, v) in raw {
        let kind = match key.as_str() {
            "ve" => CalibrationKind::Ve,
            "indicatedEfficiency" => CalibrationKind::IndicatedEfficiency,
            "fmep" => CalibrationKind::Fmep,
            _ => return Err(fail("grandeza desconhecida no pacote.")),
        };
        maps.insert(kind, normalize_calibration_map(v, kind)?);
    }
    calibration_snapshot(&maps)
}
