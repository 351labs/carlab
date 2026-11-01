//! Original, evidence-conditioned nominal rod screen. This is a faithful port
//! of the v4 TypeScript model, not a material database or a component life model.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialProvenance {
    pub kind: String,
    pub source: String,
    pub conditions: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowableStressPoint {
    pub temperature_k: f64,
    pub value: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FatiguePoint {
    #[serde(rename = "stressAmplitudeMPa")]
    pub stress_amplitude_mpa: f64,
    pub cycles: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FatigueCurve {
    pub temperature_k: f64,
    pub temperature_tolerance_k: f64,
    pub stress_ratio: f64,
    pub stress_ratio_tolerance: f64,
    pub conditions: String,
    pub points: Vec<FatiguePoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialCard {
    pub schema: u8,
    pub name: String,
    pub provenance: MaterialProvenance,
    #[serde(rename = "allowableStressMPa")]
    pub allowable_stress_mpa: Vec<AllowableStressPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fatigue_curves: Option<Vec<FatigueCurve>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaterialScreenConfig {
    pub net_section_mm2: f64,
    pub stress_concentration: f64,
    pub component_temperature_k: f64,
    pub component_temperature_source: String,
    pub crankcase_pressure_pa: f64,
    pub duration_seconds: f64,
    pub cycles_per_engine_cycle: f64,
    pub material: Option<MaterialCard>,
}

impl Default for MaterialScreenConfig {
    fn default() -> Self {
        Self {
            net_section_mm2: 400.0,
            stress_concentration: 1.0,
            component_temperature_k: 373.15,
            component_temperature_source:
                "Temperatura do componente assumida pelo usuário; não é a temperatura do gás."
                    .into(),
            crankcase_pressure_pa: 101_325.0,
            duration_seconds: 60.0,
            cycles_per_engine_cycle: 1.0,
            material: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MechanicalCycleInput {
    pub angle_deg: Vec<f64>,
    pub pressure_pa: Vec<f64>,
    pub bore_m: f64,
    pub stroke_m: f64,
    pub rod_length_m: f64,
    pub reciprocating_mass_kg: f64,
    pub rpm: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MechanicalTrace {
    pub angle_deg: Vec<f64>,
    pub gas_force_n: Vec<f64>,
    pub inertia_force_n: Vec<f64>,
    pub rod_compression_force_n: Vec<f64>,
    #[serde(rename = "stressMPa")]
    pub stress_mpa: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FatigueResult {
    pub status: String,
    pub reason: String,
    pub curve_temperature_k: Option<f64>,
    pub cycles_at_amplitude: Option<f64>,
    pub applied_envelope_cycles: f64,
    pub damage_fraction: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialScreenResult {
    pub status: String,
    pub reason: String,
    pub material_name: Option<String>,
    pub provenance: Option<MaterialProvenance>,
    #[serde(rename = "allowableStressMPa")]
    pub allowable_stress_mpa: Option<f64>,
    #[serde(rename = "peakTensileStressMPa")]
    pub peak_tensile_stress_mpa: f64,
    #[serde(rename = "peakCompressiveStressMPa")]
    pub peak_compressive_stress_mpa: f64,
    #[serde(rename = "maximumAbsoluteStressMPa")]
    pub maximum_absolute_stress_mpa: f64,
    #[serde(rename = "stressAmplitudeMPa")]
    pub stress_amplitude_mpa: f64,
    #[serde(rename = "meanStressMPa")]
    pub mean_stress_mpa: f64,
    pub stress_ratio: Option<f64>,
    pub peak_tensile_angle_deg: Option<f64>,
    pub peak_compressive_angle_deg: Option<f64>,
    pub trace: MechanicalTrace,
    pub fatigue: FatigueResult,
    pub assumptions: Vec<String>,
}

fn finite(value: &Value, label: &str) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("{label}: número finito obrigatório."))
}
fn positive(value: &Value, label: &str) -> Result<f64, String> {
    let n = finite(value, label)?;
    if n <= 0.0 {
        return Err(format!("{label}: valor finito positivo obrigatório."));
    }
    Ok(n)
}
fn nonnegative(value: &Value, label: &str) -> Result<f64, String> {
    let n = finite(value, label)?;
    if n < 0.0 {
        return Err(format!("{label}: valor finito não negativo obrigatório."));
    }
    Ok(n)
}
fn text(value: &Value, label: &str, max: usize) -> Result<String, String> {
    let s = value
        .as_str()
        .ok_or_else(|| format!("{label}: texto obrigatório e limitado a {max} caracteres."))?;
    if s.trim().is_empty() || s.encode_utf16().count() > max {
        return Err(format!(
            "{label}: texto obrigatório e limitado a {max} caracteres."
        ));
    }
    Ok(s.trim().to_owned())
}
fn bounded(value: &Value, fallback: f64, lo: f64, hi: f64) -> f64 {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .map_or(fallback, |v| v.clamp(lo, hi))
}
fn nonnegative_default(value: &Value, label: &str) -> Result<f64, String> {
    if value.is_null() {
        Ok(0.0)
    } else {
        nonnegative(value, label)
    }
}

/// Strict JSON boundary. Unknown fields are discarded, and every returned value
/// is independently owned. No unspecified material strength is generated.
pub fn parse_material_card(value: &Value) -> Result<MaterialCard, String> {
    if !value.is_object() || value["schema"].as_f64() != Some(1.0) {
        return Err("Ficha de material inválida: use schema 1.".into());
    }
    let p = &value["provenance"];
    if !p.is_object() {
        return Err("A ficha precisa de proveniência.".into());
    }
    let kind = p["kind"].as_str().unwrap_or("");
    if !matches!(kind, "assumed" | "fitted" | "measured") {
        return Err("Proveniência deve ser assumed, fitted ou measured.".into());
    }
    let values = value["allowableStressMPa"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or("Forneça de 1 a 128 limites de tensão por temperatura.")?;
    let mut allowable_stress_mpa = Vec::with_capacity(values.len());
    for point in values {
        if !point.is_object() {
            return Err("Ponto de tensão admissível inválido.".into());
        }
        allowable_stress_mpa.push(AllowableStressPoint {
            temperature_k: positive(&point["temperatureK"], "Temperatura")?,
            value: positive(&point["value"], "Tensão nominal admissível")?,
        });
    }
    allowable_stress_mpa.sort_by(|a, b| a.temperature_k.total_cmp(&b.temperature_k));
    if allowable_stress_mpa
        .windows(2)
        .any(|p| p[0].temperature_k == p[1].temperature_k)
    {
        return Err("Temperaturas duplicadas na ficha.".into());
    }
    let fatigue_curves = match value.get("fatigueCurves") {
        None => None,
        Some(raw) => {
            let curves = raw
                .as_array()
                .filter(|v| v.len() <= 32)
                .ok_or("Use no máximo 32 curvas de fadiga.")?;
            let mut result = Vec::with_capacity(curves.len());
            for curve in curves {
                if !curve.is_object() {
                    return Err("Curva S–N precisa de 2 a 128 pontos.".into());
                }
                let raw_points = curve["points"]
                    .as_array()
                    .filter(|v| v.len() >= 2 && v.len() <= 128)
                    .ok_or("Curva S–N precisa de 2 a 128 pontos.")?;
                let mut points = Vec::with_capacity(raw_points.len());
                for point in raw_points {
                    if !point.is_object() {
                        return Err("Ponto S–N inválido.".into());
                    }
                    points.push(FatiguePoint {
                        stress_amplitude_mpa: positive(
                            &point["stressAmplitudeMPa"],
                            "Amplitude de tensão",
                        )?,
                        cycles: positive(&point["cycles"], "Ciclos")?,
                    });
                }
                points.sort_by(|a, b| a.stress_amplitude_mpa.total_cmp(&b.stress_amplitude_mpa));
                if points.windows(2).any(|p| {
                    p[1].stress_amplitude_mpa <= p[0].stress_amplitude_mpa
                        || p[1].cycles >= p[0].cycles
                }) {
                    return Err(
                        "S–N deve ter amplitude crescente e número de ciclos decrescente.".into(),
                    );
                }
                result.push(FatigueCurve {
                    temperature_k: positive(&curve["temperatureK"], "Temperatura S–N")?,
                    temperature_tolerance_k: nonnegative_default(
                        &curve["temperatureToleranceK"],
                        "Domínio de temperatura S–N",
                    )?,
                    stress_ratio: finite(&curve["stressRatio"], "Razão R S–N")?,
                    stress_ratio_tolerance: nonnegative_default(
                        &curve["stressRatioTolerance"],
                        "Domínio de R S–N",
                    )?,
                    conditions: text(&curve["conditions"], "Condições S–N", 2000)?,
                    points,
                });
            }
            Some(result)
        }
    };
    Ok(MaterialCard {
        schema: 1,
        name: text(&value["name"], "Nome", 120)?,
        provenance: MaterialProvenance {
            kind: kind.into(),
            source: text(&p["source"], "Fonte", 1000)?,
            conditions: text(&p["conditions"], "Condições", 2000)?,
        },
        allowable_stress_mpa,
        fatigue_curves,
    })
}

pub fn normalize_material_screen_config(value: &Value) -> Result<MaterialScreenConfig, String> {
    let default = MaterialScreenConfig::default();
    let source = if value.is_object() {
        value
    } else {
        &Value::Null
    };
    let temperature_source = source["componentTemperatureSource"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // Keep valid Unicode scalar boundaries while retaining the JavaScript limit
    // of 1,000 UTF-16 units for ordinary imported text.
    let temperature_source = temperature_source
        .map(|s| {
            let mut units = 0;
            s.chars()
                .take_while(|c| {
                    units += c.len_utf16();
                    units <= 1000
                })
                .collect()
        })
        .unwrap_or(default.component_temperature_source);
    Ok(MaterialScreenConfig {
        net_section_mm2: bounded(
            &source["netSectionMm2"],
            default.net_section_mm2,
            1.0,
            100_000.0,
        ),
        stress_concentration: bounded(
            &source["stressConcentration"],
            default.stress_concentration,
            1.0,
            20.0,
        ),
        component_temperature_k: bounded(
            &source["componentTemperatureK"],
            default.component_temperature_k,
            150.0,
            2000.0,
        ),
        component_temperature_source: temperature_source,
        crankcase_pressure_pa: bounded(
            &source["crankcasePressurePa"],
            default.crankcase_pressure_pa,
            1000.0,
            1e6,
        ),
        duration_seconds: bounded(
            &source["durationSeconds"],
            default.duration_seconds,
            0.0,
            1e9,
        ),
        cycles_per_engine_cycle: bounded(
            &source["cyclesPerEngineCycle"],
            default.cycles_per_engine_cycle,
            0.01,
            100.0,
        ),
        material: if source["material"].is_null() {
            None
        } else {
            Some(parse_material_card(&source["material"])?)
        },
    })
}

fn interpolate_allowable(points: &[AllowableStressPoint], temperature: f64) -> Option<f64> {
    if temperature < points.first()?.temperature_k || temperature > points.last()?.temperature_k {
        return None;
    }
    for (i, point) in points.iter().enumerate() {
        if temperature == point.temperature_k {
            return Some(point.value);
        }
        if i > 0 && temperature < point.temperature_k {
            let a = &points[i - 1];
            let t = (temperature - a.temperature_k) / (point.temperature_k - a.temperature_k);
            return Some(a.value + (point.value - a.value) * t);
        }
    }
    None
}
fn interpolate_fatigue(points: &[FatiguePoint], amplitude: f64) -> Option<f64> {
    if amplitude < points.first()?.stress_amplitude_mpa
        || amplitude > points.last()?.stress_amplitude_mpa
    {
        return None;
    }
    for (i, point) in points.iter().enumerate() {
        if amplitude == point.stress_amplitude_mpa {
            return Some(point.cycles);
        }
        if i > 0 && amplitude < point.stress_amplitude_mpa {
            let a = &points[i - 1];
            let t = (amplitude / a.stress_amplitude_mpa).ln()
                / (point.stress_amplitude_mpa / a.stress_amplitude_mpa).ln();
            return Some((a.cycles.ln() + (point.cycles.ln() - a.cycles.ln()) * t).exp());
        }
    }
    None
}

pub fn screen_material(
    cycle: &MechanicalCycleInput,
    input: &MaterialScreenConfig,
) -> Result<MaterialScreenResult, String> {
    // Public Rust callers can construct typed values directly. Revalidate them
    // through the same import boundary as native JSON and browser callers.
    let config =
        normalize_material_screen_config(&serde_json::to_value(input).map_err(|e| e.to_string())?)?;
    let count = cycle.angle_deg.len();
    if !(3..=20_000).contains(&count) || cycle.pressure_pa.len() != count {
        return Err("Traço mecânico precisa de ângulos e pressões de mesmo tamanho.".into());
    }
    for (n, label, allow_zero) in [
        (cycle.bore_m, "Diâmetro", false),
        (cycle.stroke_m, "Curso", false),
        (cycle.rod_length_m, "Biela", false),
        (cycle.reciprocating_mass_kg, "Massa alternativa", true),
        (cycle.rpm, "RPM", true),
    ] {
        if !n.is_finite() || n < 0.0 || (!allow_zero && n == 0.0) {
            return Err(format!(
                "{label}: valor finito {} obrigatório.",
                if allow_zero {
                    "não negativo"
                } else {
                    "positivo"
                }
            ));
        }
    }
    let (bore, stroke, rod, mass, rpm) = (
        cycle.bore_m,
        cycle.stroke_m,
        cycle.rod_length_m,
        cycle.reciprocating_mass_kg,
        cycle.rpm,
    );
    let r = stroke / 2.0;
    if rod <= r {
        return Err("Comprimento da biela deve superar o raio da manivela.".into());
    }
    if cycle.angle_deg[0].abs() > 1e-6 || (cycle.angle_deg[count - 1] - 720.0).abs() > 1e-6 {
        return Err("O traço deve cobrir 0 a 720 graus.".into());
    }
    let area = std::f64::consts::PI * bore * bore / 4.0;
    let omega = rpm * 2.0 * std::f64::consts::PI / 60.0;
    let mut trace = MechanicalTrace {
        angle_deg: Vec::with_capacity(count),
        gas_force_n: Vec::with_capacity(count),
        inertia_force_n: Vec::with_capacity(count),
        rod_compression_force_n: Vec::with_capacity(count),
        stress_mpa: Vec::with_capacity(count),
    };
    let (mut maximum, mut minimum, mut maximum_angle, mut minimum_angle) =
        (f64::NEG_INFINITY, f64::INFINITY, 0.0, 0.0);
    for i in 0..count {
        let (angle, pressure) = (cycle.angle_deg[i], cycle.pressure_pa[i]);
        if !angle.is_finite() {
            return Err("Ângulo: número finito obrigatório.".into());
        }
        if !pressure.is_finite() || pressure < 0.0 {
            return Err("Pressão absoluta: valor finito não negativo obrigatório.".into());
        }
        if i > 0 && angle <= cycle.angle_deg[i - 1] {
            return Err("Ângulos devem ser estritamente crescentes.".into());
        }
        let theta = angle * std::f64::consts::PI / 180.0;
        let (s, c) = (theta.sin(), theta.cos());
        let root = (rod * rod - r * r * s * s).sqrt();
        let acceleration_per_omega_squared =
            r * c + r * r * (2.0 * theta).cos() / root + r.powi(4) * s * s * c * c / root.powi(3);
        let gas = (pressure - config.crankcase_pressure_pa) * area;
        let inertia = mass * omega * omega * acceleration_per_omega_squared;
        let force = (gas - inertia) / (root / rod);
        let stress = -force * config.stress_concentration / config.net_section_mm2;
        if !stress.is_finite() {
            return Err("Estado mecânico não finito.".into());
        }
        trace.angle_deg.push(angle);
        trace.gas_force_n.push(gas);
        trace.inertia_force_n.push(inertia);
        trace.rod_compression_force_n.push(force);
        trace.stress_mpa.push(stress);
        if stress > maximum {
            maximum = stress;
            maximum_angle = angle;
        }
        if stress < minimum {
            minimum = stress;
            minimum_angle = angle;
        }
    }
    let amplitude = (maximum - minimum) / 2.0;
    let mean = (maximum + minimum) / 2.0;
    let ratio = if maximum.abs() > 1e-12 {
        Some(minimum / maximum)
    } else {
        None
    };
    let absolute = maximum.abs().max(minimum.abs());
    let card = config.material.as_ref();
    let allowable = card.and_then(|card| {
        interpolate_allowable(&card.allowable_stress_mpa, config.component_temperature_k)
    });
    let mut fatigue = FatigueResult {
        status: "not-evaluated".into(),
        reason: if card.is_some() {
            "Sem curva S–N compatível com temperatura, razão R e amplitude."
        } else {
            "Sem ficha de material fornecida."
        }
        .into(),
        curve_temperature_k: None,
        cycles_at_amplitude: None,
        applied_envelope_cycles: rpm / 120.0
            * config.duration_seconds
            * config.cycles_per_engine_cycle,
        damage_fraction: None,
    };
    if let (Some(card), Some(ratio)) = (card, ratio) {
        if amplitude > 0.0 {
            let mut curves: Vec<_> = card
                .fatigue_curves
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .filter(|curve| {
                    (config.component_temperature_k - curve.temperature_k).abs()
                        <= curve.temperature_tolerance_k + 1e-8
                        && (ratio - curve.stress_ratio).abs() <= curve.stress_ratio_tolerance + 1e-8
                })
                .collect();
            curves.sort_by(|a, b| {
                (config.component_temperature_k - a.temperature_k)
                    .abs()
                    .total_cmp(&(config.component_temperature_k - b.temperature_k).abs())
            });
            for curve in curves {
                if let Some(cycles) = interpolate_fatigue(&curve.points, amplitude) {
                    fatigue.status = "evaluated".into();
                    fatigue.reason = "Triagem de envelope com curva fornecida; não é vida validada do componente.".into();
                    fatigue.curve_temperature_k = Some(curve.temperature_k);
                    fatigue.cycles_at_amplitude = Some(cycles);
                    fatigue.damage_fraction = Some(fatigue.applied_envelope_cycles / cycles);
                    break;
                }
            }
        }
    }
    let status = match allowable {
        None => "not-evaluated",
        Some(allowable) if absolute <= allowable => "within-card",
        Some(_) => "exceeds-card",
    };
    let reason = if card.is_none() {
        "Sem ficha de material fornecida."
    } else if allowable.is_none() {
        "Temperatura do componente fora dos limites fornecidos."
    } else if status == "within-card" {
        "Tensão nominal dentro do limite fornecido; sem certificação do componente."
    } else {
        "Tensão nominal excede o limite fornecido."
    };
    Ok(MaterialScreenResult {
        status: status.into(), reason: reason.into(), material_name: card.map(|c| c.name.clone()), provenance: card.map(|c| c.provenance.clone()), allowable_stress_mpa: allowable,
        peak_tensile_stress_mpa: maximum.max(0.0), peak_compressive_stress_mpa: (-minimum).max(0.0), maximum_absolute_stress_mpa: absolute, stress_amplitude_mpa: amplitude, mean_stress_mpa: mean, stress_ratio: ratio,
        peak_tensile_angle_deg: if maximum > 0.0 { Some(maximum_angle) } else { None }, peak_compressive_angle_deg: if minimum < 0.0 { Some(minimum_angle) } else { None }, trace, fatigue,
        assumptions: vec![
            "Modelo axial nominal da biela; não calcula tensão local por elementos finitos, flambagem ou vida segura.".into(),
            "Pressão e inércia combinadas no mesmo ângulo, com velocidade angular constante em cada ciclo.".into(),
            "Extremos limitados à amostragem angular do traço recebido.".into(),
            "Seção resistente e fator de concentração são hipóteses fornecidas pelo usuário.".into(),
            config.component_temperature_source,
            format!("Contagem de fadiga assume {} envelope(s) por ciclo de 720°; não há contagem rainflow nem histórico multiaxial.", config.cycles_per_engine_cycle),
            "Não há correção de tensão média: a curva S–N deve corresponder ao R e ao domínio térmico fornecidos.".into(),
            "Limite de tensão simétrico de projeto fornecido na ficha; não é automaticamente resistência ao escoamento ou limite de fadiga.".into(),
        ],
    })
}
