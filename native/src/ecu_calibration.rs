//! Original bounded EFI fitting/search workflows. A simulated optimum is not a
//! measured engine tune, knock limit, emissions result or component safety claim.
use crate::config::EngineConfig;
use crate::ecu::{CombustionMode, EcuConfig, EcuMap, EcuMapKind};
use crate::maps::{CalibrationProvenance, CalibrationValidation};
use crate::powertrain::{
    ControlledPointOverrides, PhysicalConfig, evaluate_controlled_point,
    evaluate_controlled_point_with_overrides,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

const MODEL: &str = crate::MODEL_VERSION;
fn backend() -> &'static str {
    if cfg!(target_arch = "wasm32") {
        "rust-wasm"
    } else {
        "rust-native"
    }
}
fn limited_text(value: &str, limit: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= limit
        })
        .collect()
}
fn fingerprint<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(&serde_json::to_value(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut h = 0xcbf29ce484222325_u64;
    for byte in bytes {
        h = (h ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    Ok(format!("fnv1a64:{h:016x}"))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EcuObservationSource {
    pub kind: String,
    pub label: String,
    pub fingerprint: String,
    pub conditions: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EcuLambdaObservation {
    pub id: String,
    pub capture_session_id: String,
    pub rpm: f64,
    pub map_bar: f64,
    pub observed_lambda: f64,
    pub steady: bool,
    pub valid: bool,
    pub injector_cut: bool,
    pub combustion_cut: bool,
    pub saturated: bool,
    pub transient: bool,
    pub warmup: bool,
    pub closed_loop_active: bool,
    pub applied_fuel_multiplier: Option<f64>,
    pub split: String,
    pub target_lambda: Option<f64>,
    pub weight: f64,
}
impl Default for EcuLambdaObservation {
    fn default() -> Self {
        Self {
            id: String::new(),
            capture_session_id: String::new(),
            rpm: 0.0,
            map_bar: 0.0,
            observed_lambda: 0.0,
            steady: false,
            valid: false,
            injector_cut: false,
            combustion_cut: false,
            saturated: false,
            transient: false,
            warmup: false,
            closed_loop_active: false,
            applied_fuel_multiplier: None,
            split: "train".into(),
            target_lambda: None,
            weight: 1.0,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EcuFitOptions {
    pub source: EcuObservationSource,
    pub regularization: f64,
    pub iterations: usize,
}
impl Default for EcuFitOptions {
    fn default() -> Self {
        Self {
            source: EcuObservationSource::default(),
            regularization: 0.01,
            iterations: 32,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedEcuObservation {
    pub index: usize,
    pub id: String,
    pub reasons: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuFitMetrics {
    pub status: String,
    pub samples: usize,
    pub observed_rmse_lambda: Option<f64>,
    pub before_rmse_lambda: Option<f64>,
    pub after_rmse_lambda: Option<f64>,
    pub before_mae_lambda: Option<f64>,
    pub after_mae_lambda: Option<f64>,
    pub maximum_after_error_lambda: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuFitCoverage {
    pub validation_condition_overlap: usize,
    pub validation_cell_overlap: usize,
    pub validation_session_overlap: usize,
    pub unknown_session_samples: usize,
    pub rpm_nodes: usize,
    pub pressure_nodes: usize,
    pub supported_nodes: usize,
    pub total_nodes: usize,
    pub supported_node_fraction: f64,
    pub supported_node_indices: Vec<[usize; 2]>,
    pub observed_cells: Vec<[usize; 2]>,
    pub total_cells: usize,
    pub training_samples: usize,
    pub validation_samples: usize,
    pub rejected_samples: usize,
    pub training_rpm_range: Option<[f64; 2]>,
    pub training_map_range_bar: Option<[f64; 2]>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuFuelMapFit {
    pub independent_validation: bool,
    pub validation_status: String,
    pub validation_warnings: Vec<String>,
    pub map: EcuMap,
    pub coverage: EcuFitCoverage,
    pub rejected: Vec<RejectedEcuObservation>,
    pub training: EcuFitMetrics,
    pub validation: EcuFitMetrics,
    pub source: EcuObservationSource,
    pub context_fingerprint: String,
    pub model: String,
    pub backend: String,
    pub method: String,
    pub status: String,
    pub bounded_nodes: usize,
    pub assumptions: Vec<String>,
}
#[derive(Clone)]
struct AcceptedObservation {
    session: String,
    rpm: f64,
    pressure: f64,
    observed: f64,
    target: f64,
    baseline: f64,
    applied: f64,
    weight: f64,
    basis: Vec<(usize, f64)>,
    cell: [usize; 2],
}
fn bracket(axis: &[f64], query: f64) -> (usize, f64) {
    let mut i = 0;
    while i + 2 < axis.len() && axis[i + 1] < query {
        i += 1;
    }
    (i, (query - axis[i]) / (axis[i + 1] - axis[i]))
}
fn basis(map: &EcuMap, rpm: f64, pressure: f64) -> (Vec<(usize, f64)>, [usize; 2]) {
    let (i, a) = bracket(&map.rpm, rpm);
    let (j, b) = bracket(&map.pressure_bar, pressure);
    let columns = map.pressure_bar.len();
    (
        [
            (i * columns + j, (1.0 - a) * (1.0 - b)),
            ((i + 1) * columns + j, a * (1.0 - b)),
            (i * columns + j + 1, (1.0 - a) * b),
            ((i + 1) * columns + j + 1, a * b),
        ]
        .into_iter()
        .filter(|(_, w)| *w > 0.0)
        .collect(),
        [i, j],
    )
}
fn metrics(observations: &[AcceptedObservation], map: &EcuMap) -> Result<EcuFitMetrics, String> {
    if observations.is_empty() {
        return Ok(EcuFitMetrics {
            status: "not-evaluated".into(),
            samples: 0,
            observed_rmse_lambda: None,
            before_rmse_lambda: None,
            after_rmse_lambda: None,
            before_mae_lambda: None,
            after_mae_lambda: None,
            maximum_after_error_lambda: None,
        });
    }
    let mut observed_square = 0.0;
    let (mut before_square, mut after_square, mut before_abs, mut after_abs, mut maximum) =
        (0.0, 0.0, 0.0, 0.0, 0.0_f64);
    for obs in observations {
        let corrected = map.sample(obs.rpm, obs.pressure)?.value;
        // This is a restricted steady, unsaturated proportional-fuel prediction,
        // not a fresh engine measurement or a closed-loop/hardware validation.
        let measured_error = obs.observed - obs.target;
        observed_square += measured_error * measured_error;
        let before = obs.observed * obs.applied / obs.baseline - obs.target;
        let after = obs.observed * obs.applied / corrected - obs.target;
        before_square += before * before;
        after_square += after * after;
        before_abs += before.abs();
        after_abs += after.abs();
        maximum = maximum.max(after.abs());
    }
    let count = observations.len() as f64;
    Ok(EcuFitMetrics {
        status: "predicted".into(),
        samples: observations.len(),
        observed_rmse_lambda: Some((observed_square / count).sqrt()),
        before_rmse_lambda: Some((before_square / count).sqrt()),
        after_rmse_lambda: Some((after_square / count).sqrt()),
        before_mae_lambda: Some(before_abs / count),
        after_mae_lambda: Some(after_abs / count),
        maximum_after_error_lambda: Some(maximum),
    })
}

/// Fits only the fuel-correction map. Target lambda, controller VE, physical VE,
/// injector characterization and the caller's configuration are never changed.
/// Partial support stays partial: untouched grid nodes retain the baseline.
pub fn fit_ecu_fuel_map(
    engine: &EngineConfig,
    config: &EcuConfig,
    observations: &[EcuLambdaObservation],
    options: &EcuFitOptions,
) -> Result<EcuFuelMapFit, String> {
    config.validate()?;
    if config.combustion_mode == CombustionMode::DirectInjectionDiesel {
        return Err("Diesel fuel-correction fitting is not supported in this version: SI lambda inversion does not identify fixed-pedal CI quantity, air-limit and injector effects. Use SI observations only; diesel search remains available.".into());
    }
    if config.fuel_correction_map.kind != EcuMapKind::FuelCorrection {
        return Err("Fit requires the fuelCorrection map slot.".into());
    }
    let source = &options.source;
    if !matches!(source.kind.as_str(), "measured" | "simulated")
        || source.label.trim().is_empty()
        || source.fingerprint.trim().is_empty()
        || source.label.len() > 1000
        || source.fingerprint.len() > 200
        || source.conditions.len() > 2000
    {
        return Err("Declare measured or simulated observations with a nonempty source label and fingerprint (and bounded conditions).".into());
    }
    if observations.is_empty() || observations.len() > 5000 {
        return Err("Fit requires 1..5000 declared observations.".into());
    }
    if !options.regularization.is_finite()
        || options.regularization <= 0.0
        || options.regularization > 100.0
        || !(1..=256).contains(&options.iterations)
    {
        return Err(
            "Fit requires regularization in (0,100] and 1..256 deterministic iterations.".into(),
        );
    }
    let mut training = Vec::new();
    let mut validation = Vec::new();
    let mut rejected = Vec::new();
    for (index, observation) in observations.iter().enumerate() {
        let id = if observation.id.trim().is_empty() {
            format!("row-{}", index + 1)
        } else {
            observation.id.clone()
        };
        let mut reasons = Vec::new();
        if !observation.rpm.is_finite()
            || observation.rpm <= 0.0
            || !observation.map_bar.is_finite()
            || observation.map_bar <= 0.0
            || !observation.observed_lambda.is_finite()
            || observation.observed_lambda <= 0.0
            || observation.observed_lambda > 10.0
            || !observation.weight.is_finite()
            || observation.weight <= 0.0
            || observation.weight > 1e6
        {
            reasons.push("invalid-numeric-observation".into());
        }
        if !observation.valid {
            reasons.push("observation-not-declared-valid".into());
        }
        if !observation.steady {
            reasons.push("observation-not-declared-steady".into());
        }
        for (flag, reason) in [
            (observation.injector_cut, "injector-cut"),
            (observation.combustion_cut, "combustion-cut"),
            (observation.saturated, "actuator-saturated"),
            (observation.transient, "transient"),
            (observation.warmup, "warmup"),
        ] {
            if flag {
                reasons.push(reason.into());
            }
        }
        if observation.closed_loop_active && observation.applied_fuel_multiplier.is_none() {
            reasons.push("closed-loop-applied-multiplier-missing".into());
        }
        if observation
            .applied_fuel_multiplier
            .is_some_and(|v| !v.is_finite() || v <= 0.0 || v > 16.0)
        {
            reasons.push("invalid-applied-fuel-multiplier".into());
        }
        if observation.capture_session_id.len() > 200 {
            reasons.push("capture-session-id-too-long".into());
        }
        if observation.split != "train" && observation.split != "validation" {
            reasons.push("unknown-split".into());
        }
        if !reasons.is_empty() {
            rejected.push(RejectedEcuObservation { index, id, reasons });
            continue;
        }
        let lambda = config
            .lambda_target_map
            .sample(observation.rpm, observation.map_bar)?;
        let correction = config
            .fuel_correction_map
            .sample(observation.rpm, observation.map_bar)?;
        let ve = config
            .ve_estimate_map
            .sample(observation.rpm, observation.map_bar)?;
        let spark = config
            .spark_advance_map
            .sample(observation.rpm, observation.map_bar)?;
        if lambda.extrapolated || correction.extrapolated || ve.extrapolated || spark.extrapolated {
            reasons.push("outside-controller-map-domain".into());
        }
        if observation
            .target_lambda
            .is_some_and(|declared| !declared.is_finite() || (declared - lambda.value).abs() > 1e-4)
        {
            reasons.push("declared-target-does-not-match-frozen-map".into());
        }
        if !reasons.is_empty() {
            rejected.push(RejectedEcuObservation { index, id, reasons });
            continue;
        }
        let (basis, cell) = basis(
            &config.fuel_correction_map,
            observation.rpm,
            observation.map_bar,
        );
        let accepted = AcceptedObservation {
            session: observation.capture_session_id.trim().into(),
            rpm: observation.rpm,
            pressure: observation.map_bar,
            observed: observation.observed_lambda,
            target: lambda.value,
            baseline: correction.value,
            applied: observation
                .applied_fuel_multiplier
                .unwrap_or(correction.value),
            weight: observation.weight,
            basis,
            cell,
        };
        if observation.split == "validation" {
            validation.push(accepted);
        } else {
            training.push(accepted);
        }
    }
    if training.is_empty() {
        return Err("No valid in-domain warm steady training observations with identified applied fueling remain; validation rows are never used for fitting.".into());
    }
    let mut map = config.fuel_correction_map.clone();
    let base: Vec<_> = map.values.iter().flatten().copied().collect();
    let nodes = base.len();
    let mut adjacency = vec![Vec::<(usize, f64)>::new(); nodes];
    for (i, obs) in training.iter().enumerate() {
        for &(node, coefficient) in &obs.basis {
            adjacency[node].push((i, coefficient));
        }
    }
    let desired: Vec<_> = training
        .iter()
        .map(|obs| obs.applied * obs.observed / obs.target - obs.baseline)
        .collect();
    let mut delta = vec![0.0; nodes];
    let mut predicted = vec![0.0; training.len()];
    // Projected coordinate descent on a strictly convex ridge objective. Each
    // observation has at most four bilinear coefficients; work is budgeted.
    for _ in 0..options.iterations {
        for node in 0..nodes {
            if adjacency[node].is_empty() {
                continue;
            }
            let mut denominator = options.regularization;
            let mut numerator = 0.0;
            for &(i, a) in &adjacency[node] {
                let w = training[i].weight;
                denominator += w * a * a;
                numerator += w * a * (desired[i] - predicted[i] + a * delta[node]);
            }
            let next = (numerator / denominator).clamp(0.25 - base[node], 4.0 - base[node]);
            let change = next - delta[node];
            delta[node] = next;
            for &(i, a) in &adjacency[node] {
                predicted[i] += a * change;
            }
        }
    }
    let columns = map.pressure_bar.len();
    let supported_node_indices: Vec<_> = adjacency
        .iter()
        .enumerate()
        .filter(|(_, observations)| !observations.is_empty())
        .map(|(node, _)| [node / columns, node % columns])
        .collect();
    let mut bounded_nodes = 0;
    for node in 0..nodes {
        let value = (base[node] + delta[node]).clamp(0.25, 4.0);
        map.values[node / columns][node % columns] = value;
        if !adjacency[node].is_empty() && (value <= 0.25 + 1e-10 || value >= 4.0 - 1e-10) {
            bounded_nodes += 1;
        }
    }
    let context_fingerprint = fingerprint(
        &json!({"engine":engine,"config":config,"source":source,"observations":observations,"options":options,"model":MODEL}),
    )?;
    let train_conditions: BTreeSet<_> = training
        .iter()
        .map(|o| (o.rpm.to_bits(), o.pressure.to_bits()))
        .collect();
    let train_cells: BTreeSet<_> = training.iter().map(|o| o.cell).collect();
    let train_sessions: BTreeSet<_> = training
        .iter()
        .filter(|o| !o.session.is_empty())
        .map(|o| o.session.as_str())
        .collect();
    let condition_overlap = validation
        .iter()
        .filter(|o| train_conditions.contains(&(o.rpm.to_bits(), o.pressure.to_bits())))
        .count();
    let cell_overlap = validation
        .iter()
        .filter(|o| train_cells.contains(&o.cell))
        .count();
    let session_overlap = validation
        .iter()
        .filter(|o| !o.session.is_empty() && train_sessions.contains(o.session.as_str()))
        .count();
    let unknown_sessions = training
        .iter()
        .chain(validation.iter())
        .filter(|o| o.session.is_empty())
        .count();
    let independent_validation = !validation.is_empty()
        && condition_overlap == 0
        && cell_overlap == 0
        && session_overlap == 0
        && unknown_sessions == 0;
    let mut validation_warnings = Vec::new();
    if validation.is_empty() {
        validation_warnings.push(
            "No declared validation observations; no held-out performance is evaluated.".into(),
        );
    }
    if !validation.is_empty() && condition_overlap > 0 {
        validation_warnings.push("Validation repeats a training RPM/MAP condition; it is not an independent operating-condition holdout.".into());
    }
    if !validation.is_empty() && cell_overlap > 0 {
        validation_warnings.push("Validation shares a fuel-map cell with training; neighboring/adjacent samples do not establish independent regime coverage.".into());
    }
    if !validation.is_empty() && session_overlap > 0 {
        validation_warnings.push(
            "Training and validation share a capture session; session leakage remains.".into(),
        );
    }
    if !validation.is_empty() && unknown_sessions > 0 {
        validation_warnings.push("Some accepted rows have no capture-session ID; split independence cannot be established.".into());
    }
    validation_warnings.push("All labels, session IDs and source classifications are caller-declared. Split separation is not verified measurement provenance or real-engine validation.".into());
    map.provenance = CalibrationProvenance {
        source: "fitted".into(),
        label: format!(
            "Fuel fit / {} / {}",
            source.kind,
            limited_text(&source.label, 100)
        ),
        version: format!("efi-fit-1:{context_fingerprint}"),
        engine_id: config.fuel_correction_map.provenance.engine_id.clone(),
        notes: Some(format!(
            "Source fingerprint: {}. Target lambda, controller VE and injector model frozen. {}",
            source.fingerprint,
            limited_text(&source.conditions, 1200)
        )),
        calibrated_at: None,
        validation: Some(CalibrationValidation {
            label: format!(
                "{} held-out rows; proportional-fuel prediction only, no independent hardware validation",
                validation.len()
            ),
            date: None,
            independent: independent_validation,
        }),
    };
    map.validate()?;
    let observed_cells: Vec<_> = training
        .iter()
        .map(|obs| obs.cell)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let range = |values: Vec<f64>| {
        [
            values.iter().copied().fold(f64::INFINITY, f64::min),
            values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        ]
    };
    Ok(EcuFuelMapFit { independent_validation, validation_status:if validation.is_empty(){"not-evaluated"}else if independent_validation{"declared-disjoint"}else{"not-independent"}.into(), validation_warnings, training: metrics(&training, &map)?, validation: metrics(&validation, &map)?, coverage: EcuFitCoverage { validation_condition_overlap:condition_overlap, validation_cell_overlap:cell_overlap, validation_session_overlap:session_overlap, unknown_session_samples:unknown_sessions, rpm_nodes: map.rpm.len(), pressure_nodes: columns, supported_nodes: supported_node_indices.len(), total_nodes: nodes, supported_node_fraction: supported_node_indices.len() as f64 / nodes as f64, supported_node_indices, observed_cells, total_cells: (map.rpm.len() - 1) * (columns - 1), training_samples: training.len(), validation_samples: validation.len(), rejected_samples: rejected.len(), training_rpm_range: Some(range(training.iter().map(|o| o.rpm).collect())), training_map_range_bar: Some(range(training.iter().map(|o| o.pressure).collect())) }, map, rejected, source: source.clone(), context_fingerprint, model: MODEL.into(), backend: backend().into(), method: "bounded-ridge-bilinear-correction-1".into(), status: "fitted-with-declared-observations".into(), bounded_nodes, assumptions: vec!["Only fuelCorrection is fitted; target lambda, VE, injector characterization and physical plant are held fixed. Lambda alone cannot separately identify VE, injector-flow and trim errors.".into(), "Predicted lambda assumes warm steady unsaturated delivery proportional to total applied fuel multiplier. Closed-loop observations require the recorded map-times-trim multiplier; before/after predictions reset trim to one. Unknown trims, injector nonlinearity and transients invalidate the inference.".into(), "Held-out errors are predictions using withheld declared observations, not a fresh hardware test or independent engine validation.".into(), "Unsupported nodes retain baseline values; coverage is reported and is not inferred from a low residual.".into(), "The source classification is caller-declared. Simulated observations remain simulated, and this fit does not establish a safe real-engine tune.".into(), "The context fingerprint is deterministic FNV-1a identity, not a cryptographic authenticity guarantee; the original source fingerprint is retained separately.".into()] })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EcuSearchOptions {
    pub objective: String,
    #[serde(skip_serializing_if = "default_lambda_bounds")]
    pub lambda_bounds: [f64; 2],
    #[serde(skip_serializing_if = "default_spark_bounds")]
    pub spark_bounds: [f64; 2],
    #[serde(skip_serializing_if = "default_steps")]
    pub lambda_steps: usize,
    #[serde(skip_serializing_if = "default_steps")]
    pub spark_steps: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diesel_quantity_min_mg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diesel_quantity_max_mg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injection_advance_min_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injection_advance_max_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diesel_quantity_steps: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injection_advance_steps: Option<usize>,
    pub budget: usize,
    pub refinement_levels: usize,
    pub requested_torque_nm: Option<f64>,
    pub torque_tolerance_nm: f64,
    pub torque_resolution_nm: f64,
    pub max_duty_fraction: f64,
    pub max_pressure_bar: Option<f64>,
    pub max_pressure_rise_bar_per_deg: Option<f64>,
    pub max_mean_piston_speed_ms: Option<f64>,
    pub required_evidence: Vec<String>,
}
impl Default for EcuSearchOptions {
    fn default() -> Self {
        Self {
            objective: "pareto".into(),
            lambda_bounds: [0.8, 1.2],
            spark_bounds: [6.0, 30.0],
            lambda_steps: 5,
            spark_steps: 5,
            diesel_quantity_min_mg: None,
            diesel_quantity_max_mg: None,
            injection_advance_min_deg: None,
            injection_advance_max_deg: None,
            diesel_quantity_steps: None,
            injection_advance_steps: None,
            budget: 64,
            refinement_levels: 2,
            requested_torque_nm: None,
            torque_tolerance_nm: 0.1,
            torque_resolution_nm: 0.1,
            max_duty_fraction: 0.85,
            max_pressure_bar: None,
            max_pressure_rise_bar_per_deg: None,
            max_mean_piston_speed_ms: None,
            required_evidence: Vec::new(),
        }
    }
}
fn default_lambda_bounds(v: &[f64; 2]) -> bool {
    *v == [0.8, 1.2]
}
fn default_spark_bounds(v: &[f64; 2]) -> bool {
    *v == [6.0, 30.0]
}
fn default_steps(v: &usize) -> bool {
    *v == 5
}
struct SearchAxes {
    diesel: bool,
    mode: &'static str,
    bounds: [[f64; 2]; 2],
    steps: [usize; 2],
    labels: [String; 2],
}
impl SearchAxes {
    fn resolve(physical: &PhysicalConfig, options: &EcuSearchOptions) -> Result<Self, String> {
        let diesel = physical.ecu.combustion_mode == CombustionMode::DirectInjectionDiesel;
        let ci_fields = options.diesel_quantity_min_mg.is_some()
            || options.diesel_quantity_max_mg.is_some()
            || options.injection_advance_min_deg.is_some()
            || options.injection_advance_max_deg.is_some()
            || options.diesel_quantity_steps.is_some()
            || options.injection_advance_steps.is_some();
        if !diesel && ci_fields {
            return Err("Diesel quantity/SOI search controls are invalid for a spark-ignition configuration.".into());
        }
        if diesel
            && (!default_lambda_bounds(&options.lambda_bounds)
                || !default_spark_bounds(&options.spark_bounds)
                || !default_steps(&options.lambda_steps)
                || !default_steps(&options.spark_steps))
        {
            return Err("SI lambda/spark axes cannot control diesel search; use diesel quantity and injection advance axes.".into());
        }
        let (bounds, steps, labels, limits, mode) = if diesel {
            (
                [
                    [
                        options.diesel_quantity_min_mg.unwrap_or(5.0),
                        options.diesel_quantity_max_mg.unwrap_or(60.0),
                    ],
                    [
                        options.injection_advance_min_deg.unwrap_or(0.0),
                        options.injection_advance_max_deg.unwrap_or(25.0),
                    ],
                ],
                [
                    options.diesel_quantity_steps.unwrap_or(5),
                    options.injection_advance_steps.unwrap_or(5),
                ],
                [
                    "Requested fuel (mg/cylinder/720 degrees)".into(),
                    "Injection start (degrees BTDC)".into(),
                ],
                [[0.0, 500.0], [-10.0, 40.0]],
                "directInjectionDiesel",
            )
        } else {
            (
                [options.lambda_bounds, options.spark_bounds],
                [options.lambda_steps, options.spark_steps],
                [
                    "Target lambda".into(),
                    "Spark advance (degrees BTDC)".into(),
                ],
                [[0.65, 1.4], [-10.0, 50.0]],
                "portInjectionSpark",
            )
        };
        for i in 0..2 {
            if bounds[i]
                .iter()
                .any(|v| !v.is_finite() || *v < limits[i][0] || *v > limits[i][1])
                || bounds[i][0] >= bounds[i][1]
            {
                return Err(format!(
                    "Search axis {} bounds must ascend within {}..{}.",
                    i + 1,
                    limits[i][0],
                    limits[i][1]
                ));
            }
            if !(2..=16).contains(&steps[i]) {
                return Err("Search axes require 2..16 steps each.".into());
            }
        }
        Ok(Self {
            diesel,
            mode,
            bounds,
            steps,
            labels,
        })
    }
    fn resolved_options(&self, options: &EcuSearchOptions) -> EcuSearchOptions {
        let mut resolved = options.clone();
        if self.diesel {
            resolved.diesel_quantity_min_mg = Some(self.bounds[0][0]);
            resolved.diesel_quantity_max_mg = Some(self.bounds[0][1]);
            resolved.injection_advance_min_deg = Some(self.bounds[1][0]);
            resolved.injection_advance_max_deg = Some(self.bounds[1][1]);
            resolved.diesel_quantity_steps = Some(self.steps[0]);
            resolved.injection_advance_steps = Some(self.steps[1]);
        }
        resolved
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuConstraintResult {
    pub name: String,
    pub status: String,
    pub value: Option<f64>,
    pub limit: Option<f64>,
    pub unit: String,
    pub source: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuSearchCandidate {
    pub id: usize,
    pub mode: String,
    pub lambda_target: Option<f64>,
    pub spark_advance_deg: Option<f64>,
    pub diesel_quantity_mg: Option<f64>,
    pub injection_advance_deg: Option<f64>,
    pub actual_quantity_mg: Option<f64>,
    pub minimum_lambda: Option<f64>,
    pub torque_nm: Option<f64>,
    pub power_kw: Option<f64>,
    pub fuel_mass_flow_kgs: Option<f64>,
    pub bsfc_gkwh: Option<f64>,
    pub actual_lambda: Option<f64>,
    pub duty_fraction: Option<f64>,
    pub peak_pressure_bar: Option<f64>,
    pub pressure_rise_bar_per_deg: Option<f64>,
    pub mean_piston_speed_ms: Option<f64>,
    pub valid: bool,
    pub feasible: bool,
    pub boundary: bool,
    pub constraints: Vec<EcuConstraintResult>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuSearchResult {
    pub mode: String,
    pub axis_labels: [String; 2],
    pub axis_bounds: [[f64; 2]; 2],
    pub candidates: Vec<EcuSearchCandidate>,
    pub pareto_ids: Vec<usize>,
    pub selected_id: Option<usize>,
    pub evaluated: usize,
    pub budget: usize,
    pub boundary_optimum: bool,
    pub unsupported_constraints: Vec<EcuConstraintResult>,
    pub context_fingerprint: String,
    pub model: String,
    pub backend: String,
    pub status: String,
    pub engine: EngineConfig,
    pub physical: PhysicalConfig,
    pub rpm: f64,
    pub throttle: f64,
    pub options: EcuSearchOptions,
    pub assumptions: Vec<String>,
}
fn upper(name: &str, value: f64, limit: f64, unit: &str, source: &str) -> EcuConstraintResult {
    EcuConstraintResult {
        name: name.into(),
        status: if value.is_finite() && value <= limit {
            "satisfied"
        } else {
            "violated"
        }
        .into(),
        value: value.is_finite().then_some(value),
        limit: Some(limit),
        unit: unit.into(),
        source: source.into(),
    }
}
fn gate(name: &str, passes: bool, source: &str) -> EcuConstraintResult {
    EcuConstraintResult {
        name: name.into(),
        status: if passes { "satisfied" } else { "violated" }.into(),
        value: None,
        limit: None,
        unit: "boolean".into(),
        source: source.into(),
    }
}
fn unsupported() -> Vec<EcuConstraintResult> {
    ["knock", "emissions", "materialLife"].into_iter().map(|name| EcuConstraintResult { name: name.into(), status: "not-evaluated".into(), value: None, limit: None, unit: "unsupported".into(), source: "No validated chemistry, knock or component-life evaluator is supplied by this model.".into() }).collect()
}
fn parameter_boundary(first: f64, second: f64, axes: &SearchAxes) -> bool {
    [
        first - axes.bounds[0][0],
        axes.bounds[0][1] - first,
        second - axes.bounds[1][0],
        axes.bounds[1][1] - second,
    ]
    .iter()
    .any(|x| x.abs() < 1e-9)
}

fn candidate(
    engine: &EngineConfig,
    physical: &PhysicalConfig,
    rpm: f64,
    throttle: f64,
    lambda: f64,
    spark: f64,
    id: usize,
    options: &EcuSearchOptions,
    axes: &SearchAxes,
) -> EcuSearchCandidate {
    let mut result = EcuSearchCandidate {
        id,
        mode: axes.mode.into(),
        lambda_target: (!axes.diesel).then_some(lambda),
        spark_advance_deg: (!axes.diesel).then_some(spark),
        diesel_quantity_mg: axes.diesel.then_some(lambda),
        injection_advance_deg: axes.diesel.then_some(spark),
        actual_quantity_mg: None,
        minimum_lambda: None,
        torque_nm: None,
        power_kw: None,
        fuel_mass_flow_kgs: None,
        bsfc_gkwh: None,
        actual_lambda: None,
        duty_fraction: None,
        peak_pressure_bar: None,
        pressure_rise_bar_per_deg: None,
        mean_piston_speed_ms: None,
        valid: false,
        feasible: false,
        boundary: parameter_boundary(lambda, spark, axes),
        constraints: Vec::new(),
        warnings: Vec::new(),
        error: None,
    };
    let evaluation = if axes.diesel {
        evaluate_controlled_point_with_overrides(
            engine,
            physical,
            rpm,
            throttle,
            &ControlledPointOverrides {
                target_lambda: None,
                spark_advance_deg: None,
                diesel_quantity_mg_per_cylinder: Some(lambda),
                injection_start_deg_btdc: Some(spark),
            },
        )
    } else {
        evaluate_controlled_point(engine, physical, rpm, throttle, Some(lambda), Some(spark))
    };
    let point = match evaluation {
        Ok(point) => point,
        Err(error) => {
            result.constraints.push(gate(
                "evaluator",
                false,
                "Actual injector/cylinder evaluator returned an error.",
            ));
            result.error = Some(error);
            return result;
        }
    };
    let finite = [
        point.torque_nm,
        point.power_kw,
        point.fuel_mass_flow_kgs,
        point.ideal_peak_pressure_bar,
        point.mean_piston_speed_ms,
        point.cycle.peak_pressure_rise_pa_per_deg,
    ]
    .iter()
    .all(|x| x.is_finite());
    if !finite {
        result.constraints.push(gate(
            "finite-evaluation",
            false,
            "The evaluator returned a nonfinite quantity.",
        ));
        result.error = Some("Nonfinite point output; no numeric output is substituted.".into());
        return result;
    }
    result.torque_nm = Some(point.torque_nm);
    result.power_kw = Some(point.power_kw);
    result.fuel_mass_flow_kgs = Some(point.fuel_mass_flow_kgs);
    result.peak_pressure_bar = Some(point.ideal_peak_pressure_bar);
    result.pressure_rise_bar_per_deg = Some(point.cycle.peak_pressure_rise_pa_per_deg / 1e5);
    result.mean_piston_speed_ms = Some(point.mean_piston_speed_ms);
    result.bsfc_gkwh =
        (point.power_kw > 0.001).then(|| point.fuel_mass_flow_kgs * 3.6e6 / point.power_kw);
    result.warnings = point.warnings.clone();
    result.constraints.push(gate(
        "finite-evaluation",
        true,
        "Finite actual injector-delivery/cylinder evaluation.",
    ));
    result.constraints.push(gate(
        "periodic-cycle",
        point.cycle.periodic_mass_relative_error <= 0.02
            && point.cycle.periodic_energy_relative_error <= 0.02,
        "Configured three-cycle settling; 2% periodic closure validity screen.",
    ));
    if let Some(ecu) = point.ecu {
        result.actual_quantity_mg = axes
            .diesel
            .then_some(ecu.state.delivered_fuel_mg_per_cylinder_cycle);
        result.minimum_lambda = if axes.diesel {
            ecu.state.minimum_lambda
        } else {
            None
        };
        result.actual_lambda = ecu.plant_lambda.filter(|v| v.is_finite() && *v > 0.0);
        result.constraints.push(gate(
            "finite-actuator",
            ecu.state.duty_fraction.is_finite() && result.actual_lambda.is_some(),
            "Finite actual fuel/air mass-ratio lambda and actuator duty required.",
        ));
        result.duty_fraction = Some(ecu.state.duty_fraction);
        result.constraints.push(gate(
            "coupling-valid",
            ecu.coupling_quantitatively_valid
                && ecu.state.quantitatively_valid
                && !ecu.state.maps_extrapolated
                && !ecu.state.injector_cut
                && !ecu.state.combustion_cut,
            "EFI state/cylinder coupling validity; no unsupported global energy-closure claim.",
        ));
        result.constraints.push(gate(
            "actuator-unsaturated",
            !ecu.state.actuator_saturated,
            "Actual injector delivery, pressure/dead-time/duty limits.",
        ));
        result.constraints.push(upper("injector-duty", ecu.state.duty_fraction, options.max_duty_fraction, "fraction", "Owner-specified duty ceiling; injector model and characterization remain assumed unless supplied."));
        if axes.diesel {
            match (result.actual_lambda,result.minimum_lambda) {
                (Some(actual),Some(minimum))=>result.constraints.push(EcuConstraintResult{name:"diesel-minimum-lambda-proxy".into(),status:if actual+1e-8>=minimum{"satisfied"}else{"violated"}.into(),value:Some(actual),limit:Some(minimum),unit:"mass-ratio lambda".into(),source:"Configured diesel minimum-lambda map; a declared air/fuel proxy, not soot, emissions or combustion-stability evidence.".into()}),
                _=>result.constraints.push(gate("diesel-minimum-lambda-proxy",false,"Diesel minimum-lambda map or evaluated fuel/air proxy unavailable.")),
            }
            if ecu.state.fuel_quantity_limited {
                result.warnings.push("Diesel requested quantity was air-limited before injection; actual delivered quantity is reported separately.".into());
            }
        }
        result.warnings.extend(ecu.coupling_flags);
    } else {
        result.constraints.push(gate(
            "efi-enabled",
            false,
            "Search requires enabled EFI and actual actuator-to-cylinder coupling.",
        ));
    }
    result.valid = result
        .constraints
        .iter()
        .filter(|c| c.name != "injector-duty" && c.name != "actuator-unsaturated")
        .all(|c| c.status == "satisfied");
    result.constraints.push(upper(
        "peak-pressure",
        point.ideal_peak_pressure_bar,
        options
            .max_pressure_bar
            .unwrap_or(physical.assumed_peak_pressure_bar),
        "bar absolute",
        "Owner-assumed scenario filter, not knock or material evidence.",
    ));
    result.constraints.push(upper(
        "mean-piston-speed",
        point.mean_piston_speed_ms,
        options
            .max_mean_piston_speed_ms
            .unwrap_or(physical.assumed_mean_piston_speed_ms),
        "m/s",
        "Owner-assumed scenario filter, not a durability certificate.",
    ));
    if let Some(limit) = options.max_pressure_rise_bar_per_deg {
        result.constraints.push(upper(
            "pressure-rise",
            point.cycle.peak_pressure_rise_pa_per_deg / 1e5,
            limit,
            "bar/deg",
            "Owner-assumed pressure-rise screen, not knock intensity.",
        ));
    }
    if options.objective == "minFuelAtTorque" {
        let target = options.requested_torque_nm.unwrap();
        result.constraints.push(upper(
            "requested-torque-error",
            (point.torque_nm - target).abs(),
            options.torque_tolerance_nm,
            "N m absolute error",
            "Requested-output band held fixed for fuel comparison.",
        ));
    }
    result.constraints.push(gate(
        "positive-brake-output",
        point.power_kw > 0.001 && point.fuel_mass_flow_kgs >= 0.0,
        "Positive useful output required; BSFC is not defined for near-zero or negative power.",
    ));
    result.feasible = result.valid && result.constraints.iter().all(|c| c.status == "satisfied");
    result
}
fn pareto(candidates: &[EcuSearchCandidate], resolution: f64) -> Vec<usize> {
    candidates
        .iter()
        .filter(|a| a.feasible)
        .filter(|a| {
            !candidates.iter().any(|b| {
                b.feasible
                    && b.id != a.id
                    && b.torque_nm.unwrap() >= a.torque_nm.unwrap() - resolution
                    && b.fuel_mass_flow_kgs.unwrap() <= a.fuel_mass_flow_kgs.unwrap()
                    && (b.torque_nm.unwrap() > a.torque_nm.unwrap() + resolution
                        || b.fuel_mass_flow_kgs.unwrap() < a.fuel_mass_flow_kgs.unwrap())
            })
        })
        .map(|c| c.id)
        .collect()
}
fn selected(candidates: &[EcuSearchCandidate], options: &EcuSearchOptions) -> Option<usize> {
    let feasible: Vec<_> = candidates.iter().filter(|c| c.feasible).collect();
    if options.objective == "minFuelAtTorque" {
        return feasible
            .into_iter()
            .min_by(|a, b| {
                a.fuel_mass_flow_kgs
                    .unwrap()
                    .total_cmp(&b.fuel_mass_flow_kgs.unwrap())
                    .then_with(|| {
                        a.diesel_quantity_mg
                            .unwrap_or(0.0)
                            .total_cmp(&b.diesel_quantity_mg.unwrap_or(0.0))
                    })
                    .then(a.id.cmp(&b.id))
            })
            .map(|c| c.id);
    }
    let peak = feasible
        .iter()
        .map(|c| c.torque_nm.unwrap())
        .fold(f64::NEG_INFINITY, f64::max);
    feasible
        .into_iter()
        .filter(|c| c.torque_nm.unwrap() >= peak - options.torque_resolution_nm)
        .min_by(|a, b| {
            a.fuel_mass_flow_kgs
                .unwrap()
                .total_cmp(&b.fuel_mass_flow_kgs.unwrap())
                .then_with(|| {
                    a.diesel_quantity_mg
                        .unwrap_or(0.0)
                        .total_cmp(&b.diesel_quantity_mg.unwrap_or(0.0))
                })
                .then(a.id.cmp(&b.id))
        })
        .map(|c| c.id)
}

fn refinement_centres(candidates: &[EcuSearchCandidate], options: &EcuSearchOptions) -> Vec<usize> {
    let mut front = pareto(candidates, options.torque_resolution_nm);
    if !front.is_empty() {
        front.sort_by(|a, b| {
            candidates[*a]
                .torque_nm
                .unwrap()
                .total_cmp(&candidates[*b].torque_nm.unwrap())
                .then(a.cmp(b))
        });
        if options.objective != "pareto" {
            return selected(candidates, options).into_iter().collect();
        }
        let count = front.len().min(4);
        return (0..count)
            .map(|i| {
                front[if count == 1 {
                    0
                } else {
                    i * (front.len() - 1) / (count - 1)
                }]
            })
            .collect();
    }
    // An infeasible initial grid can still approach an output band. It never
    // becomes a feasible optimum unless the exact evaluator passes every gate.
    candidates
        .iter()
        .filter(|c| c.valid)
        .min_by(|a, b| {
            let penalty = |c: &EcuSearchCandidate| {
                c.constraints
                    .iter()
                    .filter(|r| r.status == "violated")
                    .map(|r| match (r.value, r.limit) {
                        (Some(v), Some(l)) => (v - l).max(0.0) / l.abs().max(1e-9),
                        _ => 1.0,
                    })
                    .sum::<f64>()
            };
            penalty(a)
                .total_cmp(&penalty(b))
                .then_with(|| b.power_kw.unwrap().total_cmp(&a.power_kw.unwrap()))
                .then(a.id.cmp(&b.id))
        })
        .map(|c| vec![c.id])
        .unwrap_or_default()
}

pub fn search_ecu_operating_point(
    engine: &EngineConfig,
    physical: &PhysicalConfig,
    rpm: f64,
    throttle: f64,
    options: &EcuSearchOptions,
) -> Result<EcuSearchResult, String> {
    if !matches!(
        options.objective.as_str(),
        "pareto" | "maxPower" | "minFuelAtTorque"
    ) {
        return Err("Unknown EFI search objective.".into());
    }
    if !options.required_evidence.is_empty() {
        return Err(format!(
            "Required evidence is unsupported by this model: {}. Knock, emissions and material life remain not-evaluated.",
            options.required_evidence.join(", ")
        ));
    }
    if !rpm.is_finite()
        || rpm < engine.idle_rpm
        || rpm >= engine.redline
        || !throttle.is_finite()
        || throttle <= 0.0
        || throttle > 1.0
    {
        return Err(
            "Search requires finite fueled RPM in [idle,redline) and throttle in (0,1].".into(),
        );
    }
    if !physical.ecu.enabled {
        return Err("EFI must be explicitly enabled for injector/cylinder search.".into());
    }
    let axes = SearchAxes::resolve(physical, options)?;
    if options.budget == 0
        || options.budget > 512
        || options.refinement_levels > 6
        || !options.max_duty_fraction.is_finite()
        || options.max_duty_fraction <= 0.0
        || options.max_duty_fraction > 1.0
        || !options.torque_tolerance_nm.is_finite()
        || options.torque_tolerance_nm <= 0.0
        || !options.torque_resolution_nm.is_finite()
        || options.torque_resolution_nm <= 0.0
        || options.torque_resolution_nm > 100.0
    {
        return Err("Search requires 2..16 axis steps, budget 1..512, 0..6 refinement levels, finite duty in (0,1] and positive torque tolerance and torque resolution in (0,100] N m.".into());
    }
    if options.objective == "minFuelAtTorque"
        && !options
            .requested_torque_nm
            .is_some_and(|v| v.is_finite() && v > 0.0)
    {
        return Err(
            "Fuel optimization requires a positive requested torque and an output tolerance."
                .into(),
        );
    }
    for bound in [
        options.max_pressure_bar,
        options.max_pressure_rise_bar_per_deg,
        options.max_mean_piston_speed_ms,
    ] {
        if bound.is_some_and(|v| !v.is_finite() || v <= 0.0) {
            return Err("Assumed search screens must be finite and positive.".into());
        }
    }
    let mut candidates = Vec::new();
    let mut seen = BTreeMap::<(i64, i64), usize>::new();
    let insert = |lambda: f64,
                  spark: f64,
                  candidates: &mut Vec<EcuSearchCandidate>,
                  seen: &mut BTreeMap<(i64, i64), usize>| {
        if candidates.len() >= options.budget {
            return;
        }
        let lambda = lambda.clamp(axes.bounds[0][0], axes.bounds[0][1]);
        let spark = spark.clamp(axes.bounds[1][0], axes.bounds[1][1]);
        let key = ((lambda * 1e9).round() as i64, (spark * 1e9).round() as i64);
        if seen.contains_key(&key) {
            return;
        }
        let id = candidates.len();
        seen.insert(key, id);
        candidates.push(candidate(
            engine, physical, rpm, throttle, lambda, spark, id, options, &axes,
        ));
    };
    // Visit the four joint corners before remaining grid points so a small
    // budget is not spent on a single lambda row. Every candidate counts.
    let mut li: Vec<_> = (0..axes.steps[0]).collect();
    let mut si: Vec<_> = (0..axes.steps[1]).collect();
    li.sort_by_key(|i| {
        if *i == 0 {
            0
        } else if *i + 1 == axes.steps[0] {
            1
        } else {
            i + 1
        }
    });
    si.sort_by_key(|i| {
        if *i == 0 {
            0
        } else if *i + 1 == axes.steps[1] {
            1
        } else {
            i + 1
        }
    });
    for (lambda, spark) in [
        (axes.bounds[0][0], axes.bounds[1][0]),
        (axes.bounds[0][1], axes.bounds[1][1]),
        (axes.bounds[0][0], axes.bounds[1][1]),
        (axes.bounds[0][1], axes.bounds[1][0]),
    ] {
        insert(lambda, spark, &mut candidates, &mut seen);
    }
    for &i in &li {
        for &j in &si {
            insert(
                axes.bounds[0][0]
                    + (axes.bounds[0][1] - axes.bounds[0][0]) * i as f64
                        / (axes.steps[0] - 1) as f64,
                axes.bounds[1][0]
                    + (axes.bounds[1][1] - axes.bounds[1][0]) * j as f64
                        / (axes.steps[1] - 1) as f64,
                &mut candidates,
                &mut seen,
            );
        }
    }
    for level in 0..options.refinement_levels {
        if candidates.len() >= options.budget {
            break;
        }
        let centres = refinement_centres(&candidates, options);
        let dl = (axes.bounds[0][1] - axes.bounds[0][0])
            / (axes.steps[0] - 1) as f64
            / 2.0_f64.powi(level as i32 + 1);
        let ds = (axes.bounds[1][1] - axes.bounds[1][0])
            / (axes.steps[1] - 1) as f64
            / 2.0_f64.powi(level as i32 + 1);
        for id in centres {
            let (lambda, spark) = (
                candidates[id]
                    .diesel_quantity_mg
                    .or(candidates[id].lambda_target)
                    .unwrap(),
                candidates[id]
                    .injection_advance_deg
                    .or(candidates[id].spark_advance_deg)
                    .unwrap(),
            );
            for a in [-1.0, 0.0, 1.0] {
                for b in [-1.0, 0.0, 1.0] {
                    insert(lambda + a * dl, spark + b * ds, &mut candidates, &mut seen);
                }
            }
        }
    }
    let pareto_ids = pareto(&candidates, options.torque_resolution_nm);
    let selected_id = selected(&candidates, options);
    let boundary_optimum = selected_id.is_some_and(|id| candidates[id].boundary);
    let evaluated = candidates.len();
    let resolved_options = axes.resolved_options(options);
    let context_fingerprint = fingerprint(
        &json!({"engine":engine,"physical":physical,"rpm":rpm,"throttle":throttle,"options":resolved_options,"model":MODEL}),
    )?;
    Ok(EcuSearchResult { mode:axes.mode.into(),axis_labels:axes.labels.clone(),axis_bounds:axes.bounds,candidates, pareto_ids, selected_id, evaluated, budget: options.budget, boundary_optimum, unsupported_constraints: unsupported(), context_fingerprint, model: MODEL.into(), backend: backend().into(), status: if selected_id.is_some() { "model-only-candidates" } else { "no-feasible-candidate" }.into(), engine: engine.clone(), physical: physical.clone(), rpm, throttle, options: resolved_options, assumptions: vec!["Deterministic budgeted grid/refinement inside an uncalibrated air-standard model; the selected point is the best evaluated feasible candidate, not a proven global or real-engine optimum.".into(), "Each candidate uses actual injector delivery and the cylinder pressure/work evaluator. SI searches lambda/spark; CI searches requested mg/cylinder/720 degrees and injection start BTDC, retaining injector and air-based quantity limits. Neither branch applies post-hoc torque multipliers.".into(), "The search is warm steady open-loop; dynamic sensor/PI/film history and drive-cycle optimization are not solved by these points. Power selection treats torque differences below the declared torque resolution as unresolved, preferring lower fuel use.".into(), "Pressure, pressure-rise, duty and piston-speed screens are declared scenario assumptions. Knock, emissions and component-safe life remain not-evaluated.".into(), "Fuel minimization holds the requested torque band. Pareto dominance uses the declared torque resolution and actual delivered fuel use at the same RPM/pedal. Equal-fuel diesel ties prefer the smaller requested quantity rather than a needlessly air-limited demand.".into(), "A boundary optimum may expose model assumptions or an insufficient search domain. Full engine/turbo energy closure and engine-specific calibration remain unresolved.".into(), "The deterministic FNV context fingerprint identifies inputs; it is not a cryptographic authenticity or safety guarantee.".into()] })
}

#[cfg(test)]
mod resolution_tests {
    use super::*;
    fn point(id: usize, torque: f64, fuel: f64) -> EcuSearchCandidate {
        EcuSearchCandidate {
            id,
            mode: "portInjectionSpark".into(),
            lambda_target: Some(1.0),
            spark_advance_deg: Some(18.0),
            diesel_quantity_mg: None,
            injection_advance_deg: None,
            actual_quantity_mg: None,
            minimum_lambda: None,
            torque_nm: Some(torque),
            power_kw: Some(torque * 3000.0 * std::f64::consts::PI / 30.0 / 1000.0),
            fuel_mass_flow_kgs: Some(fuel),
            bsfc_gkwh: None,
            actual_lambda: Some(1.0),
            duty_fraction: Some(0.2),
            peak_pressure_bar: Some(60.0),
            pressure_rise_bar_per_deg: Some(3.0),
            mean_piston_speed_ms: Some(10.0),
            valid: true,
            feasible: true,
            boundary: false,
            constraints: Vec::new(),
            warnings: Vec::new(),
            error: None,
        }
    }
    #[test]
    fn unresolved_torque_differences_cannot_win_by_numerical_noise() {
        let options = EcuSearchOptions::default();
        let points = vec![point(0, 100.0, 0.01), point(1, 100.00000001, 0.0105)];
        assert_eq!(selected(&points, &options), Some(0));
        assert_eq!(pareto(&points, 0.1), vec![0]);
        let points = vec![point(0, 100.0, 0.01), point(1, 100.2, 0.0105)];
        assert_eq!(selected(&points, &options), Some(1));
        assert_eq!(pareto(&points, 0.1), vec![0, 1]);
    }
}
