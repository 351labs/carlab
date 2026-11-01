//! Original air-standard single-zone four-stroke model, faithfully ported from
//! the lab's TypeScript reference. Angles: 0 intake TDC, 180 intake BDC,
//! 360 firing TDC, 540 expansion BDC, 720 exhaust TDC. Fuel is finite external
//! heat input; it does not add working-fluid mass or resolve gas chemistry.
use crate::gas_properties::{Blend, FuelChemistry, Mixture};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::f64::consts::PI;

const R: f64 = 287.05;
const DEG: f64 = PI / 180.0;

/// Working-fluid property set. `AirStandard` is the legacy gamma/linear-cv air.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PropertyModel {
    #[default]
    AirStandard,
    Nasa7FixedComposition,
}
/// Gas-to-wall coefficient. `Woschni`: SAE 670931 form, p in kPa (see docs).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HeatTransferModel {
    #[default]
    Constant,
    Woschni,
}
fn choice<T: for<'de> Deserialize<'de> + Default>(v: &Value, key: &str) -> Result<T, String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(x) => serde_json::from_value(x.clone()).map_err(|_| format!("Unsupported {key}: {x}")),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CylinderCycleConfig {
    pub bore_m: f64,
    pub stroke_m: f64,
    pub rod_length_m: f64,
    pub compression_ratio: f64,
    pub rpm: f64,
    pub intake_pressure_pa: f64,
    pub intake_temperature_k: f64,
    pub exhaust_pressure_pa: f64,
    pub exhaust_temperature_k: f64,
    pub intake_open_deg: f64,
    pub intake_close_deg: f64,
    pub exhaust_open_deg: f64,
    pub exhaust_close_deg: f64,
    pub intake_valve_diameter_m: f64,
    pub exhaust_valve_diameter_m: f64,
    pub intake_valve_lift_m: f64,
    pub exhaust_valve_lift_m: f64,
    pub intake_valve_count: f64,
    pub exhaust_valve_count: f64,
    pub discharge_coefficient: f64,
    pub spark_advance_deg: f64,
    pub burn_duration_deg: f64,
    pub wiebe_shape: f64,
    pub wiebe_efficiency: f64,
    pub air_fuel_ratio: f64,
    pub fuel_lhv_jkg: f64,
    pub combustion_efficiency: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fuel_mass_kg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oxygen_limit_afr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub combustion_start_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fuel_delivery_start_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fuel_delivery_duration_deg: Option<f64>,
    pub wall_temperature_k: f64,
    pub heat_transfer_wm2_k: f64,
    pub gamma: f64,
    pub variable_heat_capacity: bool,
    pub property_model: PropertyModel,
    /// Fuel CH_yO_z used only by the NASA property model (products/stoichiometry).
    pub fuel_hydrogen_carbon_ratio: f64,
    pub fuel_oxygen_carbon_ratio: f64,
    pub heat_transfer_model: HeatTransferModel,
    /// Scales the Woschni coefficient only; constant mode uses heatTransferWm2K.
    pub heat_transfer_multiplier: f64,
    /// SI prescribed heat-release start = 360 - sparkAdvanceDeg + this offset.
    pub spark_to_soc_deg: f64,
    pub initial_pressure_pa: f64,
    pub initial_temperature_k: f64,
    pub step_deg: f64,
    pub settling_cycles: f64,
}

fn clamp(n: f64, a: f64, b: f64) -> f64 {
    n.max(a).min(b)
}
fn bound(v: &Value, key: &str, fallback: f64, a: f64, b: f64) -> f64 {
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|n| clamp(n, a, b))
        .unwrap_or(fallback)
}
impl Default for CylinderCycleConfig {
    fn default() -> Self {
        Self::from_value(&Value::Null).expect("finite cylinder defaults")
    }
}
impl<'de> Deserialize<'de> for CylinderCycleConfig {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_value(&Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}
impl CylinderCycleConfig {
    /// Missing defaults depend on the supplied stroke and exhaust boundary, as
    /// in the TS normalizer. Deserialization uses this rather than static serde
    /// defaults, so partial JSON has the same semantics as partial TS input.
    pub fn from_value(v: &Value) -> Result<Self, String> {
        let stroke_m = bound(v, "strokeM", 0.086, 0.02, 0.22);
        let intake_pressure_pa = bound(v, "intakePressurePa", 101325.0, 15000.0, 500000.0);
        let exhaust_pressure_pa = bound(v, "exhaustPressurePa", 106000.0, 30000.0, 700000.0);
        let exhaust_temperature_k = bound(v, "exhaustTemperatureK", 800.0, 240.0, 1800.0);
        let step = bound(v, "stepDeg", 2.0, 0.125, 6.0);
        let bins = (720.0 / step).round();
        let delivery_start = v.get("fuelDeliveryStartDeg");
        let delivery_duration = v.get("fuelDeliveryDurationDeg");
        if delivery_start.is_some() != delivery_duration.is_some() {
            return Err("Fuel delivery start and duration must be supplied together.".into());
        }
        let delivery = if let (Some(a), Some(b)) = (delivery_start, delivery_duration) {
            let a = a.as_f64().ok_or("Invalid fuel delivery start")?;
            let b = b.as_f64().ok_or("Invalid fuel delivery duration")?;
            if !a.is_finite() || !b.is_finite() || a < 0.0 || b <= 0.0 || a + b > 720.0 {
                return Err(
                    "Fuel delivery must be a finite positive event inside 0..720 degrees.".into(),
                );
            }
            Some((a, b))
        } else {
            None
        };

        Ok(Self {
            bore_m: bound(v, "boreM", 0.086, 0.025, 0.2),
            stroke_m,
            rod_length_m: bound(
                v,
                "rodLengthM",
                stroke_m * 1.7,
                stroke_m * 0.6,
                stroke_m * 3.0,
            ),
            compression_ratio: bound(v, "compressionRatio", 10.5, 5.0, 18.0),
            rpm: bound(v, "rpm", 3000.0, 300.0, 18000.0),
            intake_pressure_pa,
            intake_temperature_k: bound(v, "intakeTemperatureK", 315.0, 230.0, 600.0),
            exhaust_pressure_pa,
            exhaust_temperature_k,
            // Model 3 widens these for cam phasing; values above 720 mean after TDC.
            intake_open_deg: bound(v, "intakeOpenDeg", 710.0, 570.0, 800.0),
            intake_close_deg: bound(v, "intakeCloseDeg", 220.0, 100.0, 330.0),
            exhaust_open_deg: bound(v, "exhaustOpenDeg", 500.0, 400.0, 650.0),
            exhaust_close_deg: bound(v, "exhaustCloseDeg", 10.0, 0.0, 150.0),
            intake_valve_diameter_m: bound(v, "intakeValveDiameterM", 0.032, 0.006, 0.09),
            exhaust_valve_diameter_m: bound(v, "exhaustValveDiameterM", 0.028, 0.006, 0.09),
            intake_valve_lift_m: bound(v, "intakeValveLiftM", 0.009, 0.0, 0.025),
            exhaust_valve_lift_m: bound(v, "exhaustValveLiftM", 0.008, 0.0, 0.025),
            intake_valve_count: bound(v, "intakeValveCount", 2.0, 1.0, 4.0).round(),
            exhaust_valve_count: bound(v, "exhaustValveCount", 2.0, 1.0, 4.0).round(),
            discharge_coefficient: bound(v, "dischargeCoefficient", 0.68, 0.0, 1.0),
            spark_advance_deg: bound(v, "sparkAdvanceDeg", 18.0, -30.0, 60.0),
            burn_duration_deg: bound(v, "burnDurationDeg", 50.0, 8.0, 120.0),
            wiebe_shape: bound(v, "wiebeShape", 2.0, 0.1, 5.0),
            wiebe_efficiency: bound(v, "wiebeEfficiency", 6.9, 1.0, 12.0),
            air_fuel_ratio: bound(v, "airFuelRatio", 14.7, 8.0, 25.0),
            fuel_lhv_jkg: bound(v, "fuelLhvJkg", 43e6, 15e6, 55e6),
            combustion_efficiency: bound(v, "combustionEfficiency", 0.96, 0.0, 1.0),
            fuel_mass_kg: v
                .get("fuelMassKg")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .map(|n| clamp(n, 0.0, 0.0006)),
            oxygen_limit_afr: v
                .get("oxygenLimitAfr")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite())
                .map(|v| clamp(v, 2.0, 25.0)),
            combustion_start_deg: v
                .get("combustionStartDeg")
                .and_then(Value::as_f64)
                .filter(|x| x.is_finite())
                .map(|x| clamp(x, 280.0, 500.0)),
            fuel_delivery_start_deg: delivery.map(|x| x.0),
            fuel_delivery_duration_deg: delivery.map(|x| x.1),
            wall_temperature_k: bound(v, "wallTemperatureK", 450.0, 230.0, 1000.0),
            heat_transfer_wm2_k: bound(v, "heatTransferWm2K", 180.0, 0.0, 3000.0),
            gamma: bound(v, "gamma", 1.33, 1.15, 1.4),
            variable_heat_capacity: v.get("variableHeatCapacity").and_then(Value::as_bool)
                == Some(true),
            property_model: choice(v, "propertyModel")?,
            fuel_hydrogen_carbon_ratio: bound(v, "fuelHydrogenCarbonRatio", 1.85, 0.5, 4.0),
            fuel_oxygen_carbon_ratio: bound(v, "fuelOxygenCarbonRatio", 0.0, 0.0, 1.0),
            heat_transfer_model: choice(v, "heatTransferModel")?,
            heat_transfer_multiplier: bound(v, "heatTransferMultiplier", 1.0, 0.0, 5.0),
            spark_to_soc_deg: bound(v, "sparkToSocDeg", 0.0, -20.0, 60.0),
            initial_pressure_pa: bound(
                v,
                "initialPressurePa",
                exhaust_pressure_pa,
                10000.0,
                700000.0,
            ),
            initial_temperature_k: bound(
                v,
                "initialTemperatureK",
                exhaust_temperature_k,
                230.0,
                1800.0,
            ),
            step_deg: 720.0 / bins,
            settling_cycles: bound(v, "settlingCycles", 3.0, 0.0, 12.0).round(),
        })
    }
    pub fn normalize(self) -> Result<Self, String> {
        Self::from_value(&serde_json::to_value(self).map_err(|e| e.to_string())?)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CylinderCycleTrace {
    pub angle_deg: Vec<f64>,
    pub pressure_pa: Vec<f64>,
    pub temperature_k: Vec<f64>,
    pub volume_m3: Vec<f64>,
    pub mass_kg: Vec<f64>,
    /// Cumulative heat released since the recorded cycle's start.
    pub heat_release_j: Vec<f64>,
    pub heat_release_rate_j_per_deg: Vec<f64>,
    pub intake_flow_kgs: Vec<f64>,
    pub exhaust_flow_kgs: Vec<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CylinderCycleResult {
    pub config: CylinderCycleConfig,
    pub trace: CylinderCycleTrace,
    /// Per cylinder per 720 degrees. Net already includes pumping.
    pub net_work_j: f64,
    pub gross_work_j: f64,
    pub pumping_work_j: f64,
    pub net_indicated_work_j: f64,
    pub imep_pa: f64,
    pub peak_pressure_pa: f64,
    pub peak_temperature_k: f64,
    pub peak_pressure_angle_deg: f64,
    pub peak_pressure_rise_pa_per_deg: f64,
    pub ca10_deg: f64,
    pub ca50_deg: f64,
    pub ca90_deg: f64,
    /// Prescribed heat-release start actually used (cycle degrees).
    #[serde(default)]
    pub soc_deg: f64,
    #[serde(default)]
    pub peak_heat_transfer_wm2_k: f64,
    /// NASA mode: equivalence ratio of the burned-gas composition in this cycle.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub burned_gas_equivalence_ratio: Option<f64>,
    /// NASA mode: fraction of fuel LHV released after rich CO/H2 retention.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub released_lhv_fraction: Option<f64>,
    pub fresh_charge_mass_kg: f64,
    pub air_mass_kg: f64,
    pub fuel_mass_kg: f64,
    pub fuel_energy_j: f64,
    pub released_heat_j: f64,
    pub residual_fraction_at_ivc: f64,
    pub wall_heat_loss_j: f64,
    pub intake_mass_in_kg: f64,
    pub intake_reverse_mass_kg: f64,
    pub exhaust_mass_kg: f64,
    pub exhaust_reverse_mass_kg: f64,
    pub exhaust_temperature_k: f64,
    pub inlet_enthalpy_j: f64,
    pub outlet_enthalpy_j: f64,
    pub mass_balance_residual_kg: f64,
    pub energy_balance_residual_j: f64,
    pub periodic_mass_relative_error: f64,
    pub periodic_energy_relative_error: f64,
    pub initial_mass_kg: f64,
    pub final_mass_kg: f64,
    pub initial_internal_energy_j: f64,
    pub final_internal_energy_j: f64,
    pub steps: usize,
    pub warnings: Vec<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oxygen_limited_fuel_mass_kg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oxygen_unburned_fuel_mass_kg: Option<f64>,
}
pub type CycleResult = CylinderCycleResult;

pub fn cylinder_volume(c: &CylinderCycleConfig, angle_deg: f64) -> f64 {
    let area = PI * c.bore_m.powi(2) / 4.0;
    let (a, l, t) = (c.stroke_m / 2.0, c.rod_length_m, angle_deg * DEG);
    let x = a * (1.0 - t.cos()) + l - (l * l - a * a * t.sin().powi(2)).sqrt();
    area * (c.stroke_m / (c.compression_ratio - 1.0) + x)
}
fn volume_derivative(c: &CylinderCycleConfig, angle: f64) -> f64 {
    let (a, t, l) = (c.stroke_m / 2.0, angle * DEG, c.rod_length_m);
    let (s, v) = (t.sin(), t.cos());
    PI * c.bore_m.powi(2) / 4.0 * (a * s + a * a * s * v / (l * l - a * a * s * s).sqrt()) * DEG
}

/// Woschni (SAE 670931) coefficient, W/(m^2 K): 3.26 B^-0.2 p^0.8 T^-0.55 w^0.8
/// with bore B in m, pressure in kPa (converted here from Pa), T in K, w in m/s.
pub fn woschni_coefficient(bore_m: f64, pressure_pa: f64, temperature_k: f64, velocity_ms: f64) -> f64 {
    3.26 * bore_m.powf(-0.2)
        * (pressure_pa / 1000.0).powf(0.8)
        * temperature_k.powf(-0.55)
        * velocity_ms.powf(0.8)
}

/// Signed A-to-B flow; a negative result means flow from B to A.
pub fn compressible_orifice_flow(
    p_a: f64,
    t_a: f64,
    p_b: f64,
    t_b: f64,
    area_m2: f64,
    cd: f64,
    gamma: f64,
    gas_r: f64,
) -> Result<f64, String> {
    if ![p_a, t_a, p_b, t_b, area_m2, cd, gamma, gas_r]
        .iter()
        .all(|n| n.is_finite())
        || p_a <= 0.0
        || p_b <= 0.0
        || t_a <= 0.0
        || t_b <= 0.0
        || gamma <= 1.0
        || gas_r <= 0.0
        || area_m2 < 0.0
        || cd < 0.0
    {
        return Err("Invalid compressible-flow boundary.".into());
    }
    if p_a == p_b || area_m2 == 0.0 || cd == 0.0 {
        return Ok(0.0);
    }
    let forward = p_a > p_b;
    let (up, down, temp) = if forward {
        (p_a, p_b, t_a)
    } else {
        (p_b, p_a, t_b)
    };
    let ratio = down / up;
    let critical = (2.0 / (gamma + 1.0)).powf(gamma / (gamma - 1.0));
    let factor = if ratio <= critical {
        gamma.sqrt() * (2.0 / (gamma + 1.0)).powf((gamma + 1.0) / (2.0 * (gamma - 1.0)))
    } else {
        (2.0 * gamma / (gamma - 1.0)
            * (ratio.powf(2.0 / gamma) - ratio.powf((gamma + 1.0) / gamma)))
        .max(0.0)
        .sqrt()
    };
    Ok((if forward { 1.0 } else { -1.0 }) * cd * area_m2 * up / (gas_r * temp).sqrt() * factor)
}

pub fn valve_effective_area(
    angle_deg: f64,
    open_deg: f64,
    close_deg: f64,
    diameter_m: f64,
    lift_m: f64,
    count: f64,
) -> f64 {
    let duration = (close_deg - open_deg + 720.0) % 720.0;
    let phase = ((angle_deg - open_deg) % 720.0 + 720.0) % 720.0;
    if duration <= 0.0 || phase >= duration {
        return 0.0;
    }
    let lift = lift_m * (PI * phase / duration).sin().powi(2);
    count * (PI * diameter_m * lift).min(PI * diameter_m.powi(2) / 4.0)
}

#[derive(Clone, Copy)]
struct State {
    m: f64,
    u: f64,
    fresh: f64,
}
struct Rates {
    dm: f64,
    du: f64,
    dfresh: f64,
    din: f64,
    dout: f64,
    hin: f64,
    hout: f64,
    work: f64,
    wall: f64,
    temp: f64,
    pressure: f64,
    htc: f64,
}
enum Props {
    Legacy { b: f64, slope: f64 },
    Nasa { air: Mixture, burned: Mixture },
}
struct Model<'a> {
    c: &'a CylinderCycleConfig,
    props: Props,
    dt_per_deg: f64,
    soc: f64,
    burn_end: f64,
    swept: f64,
    mean_piston_speed: f64,
    /// Woschni motored-pressure reference captured at this cycle's IVC: p, V, T, n.
    ivc_state: Option<(f64, f64, f64, f64)>,
}
impl Model<'_> {
    fn blend(&self, fresh: f64) -> Option<Blend<'_>> {
        match &self.props {
            Props::Nasa { air, burned } => Some(Blend { air, burned, fresh }),
            Props::Legacy { .. } => None,
        }
    }
    fn specific_u(&self, t: f64, fresh: f64) -> f64 {
        match &self.props {
            Props::Legacy { b, slope } => b * t + 0.5 * slope * t * t,
            Props::Nasa { .. } => self.blend(fresh).unwrap().u(t),
        }
    }
    fn temperature(&self, m: f64, u: f64, fresh: f64) -> f64 {
        let e = u / m;
        match &self.props {
            Props::Legacy { b, slope } => {
                if *slope == 0.0 {
                    e / b
                } else {
                    2.0 * e / (b + (b * b + 2.0 * slope * e).sqrt())
                }
            }
            Props::Nasa { .. } => self.blend(fresh).unwrap().temperature(e).unwrap_or(f64::NAN),
        }
    }
    fn gas_r(&self, fresh: f64) -> f64 {
        self.blend(fresh).map_or(R, |b| b.gas_r())
    }
    fn enthalpy(&self, t: f64, fresh: f64) -> f64 {
        match &self.props {
            Props::Legacy { .. } => self.specific_u(t, fresh) + R * t,
            Props::Nasa { .. } => self.blend(fresh).unwrap().h(t),
        }
    }
    fn gamma_at(&self, t: f64, fresh: f64) -> f64 {
        match &self.props {
            Props::Legacy { b, slope } => 1.0 + R / (b + slope * t),
            Props::Nasa { .. } => self.blend(fresh).unwrap().gamma(t),
        }
    }
    /// Unburned-air mass fraction for properties. NASA mode converts the fresh
    /// tracer progressively with the prescribed burn; legacy flips it at SOC.
    fn fresh_fraction(&self, angle: f64, s: State) -> f64 {
        let frac = clamp(s.fresh / s.m, 0.0, 1.0);
        match self.props {
            Props::Nasa { .. } if angle >= self.soc && angle <= self.burn_end => {
                frac * (1.0 - self.wiebe(angle))
            }
            _ => frac,
        }
    }
    fn state_temperature(&self, angle: f64, s: State) -> f64 {
        self.temperature(s.m, s.u, self.fresh_fraction(angle, s))
    }
    fn state_pressure(&self, angle: f64, s: State) -> f64 {
        let y = self.fresh_fraction(angle, s);
        s.m * self.gas_r(y) * self.temperature(s.m, s.u, y) / cylinder_volume(self.c, angle)
    }
    fn heat_transfer_coefficient(&self, angle: f64, p: f64, t: f64, v: f64) -> f64 {
        let c = self.c;
        if c.heat_transfer_model == HeatTransferModel::Constant {
            return c.heat_transfer_wm2_k;
        }
        // Woschni: 6.18 Up during gas exchange, 2.28 Up closed, plus the
        // combustion term 3.24e-3 Vd Tr/(pr Vr) (p - p_motored) after SOC.
        let closed = angle >= c.intake_close_deg && angle < c.exhaust_open_deg;
        let mut w = if closed { 2.28 } else { 6.18 } * self.mean_piston_speed;
        if let (true, Some((pr, vr, tr, n))) = (closed && angle >= self.soc, self.ivc_state) {
            let motored = pr * (vr / v).powf(n);
            w += 0.00324 * self.swept * tr / (pr * vr) * (p - motored).max(0.0);
        }
        c.heat_transfer_multiplier * woschni_coefficient(c.bore_m, p, t, w)
    }
    fn prescribed_wiebe(&self, angle: f64) -> f64 {
        let x = clamp((angle - self.soc) / self.c.burn_duration_deg, 0.0, 1.0);
        (1.0 - (-self.c.wiebe_efficiency * x.powf(self.c.wiebe_shape + 1.0)).exp())
            / (1.0 - (-self.c.wiebe_efficiency).exp())
    }
    fn wiebe(&self, angle: f64) -> f64 {
        let prescribed = self.prescribed_wiebe(angle);
        if let Some(start) = self.c.fuel_delivery_start_deg {
            prescribed.min(clamp(
                (angle - start) / self.c.fuel_delivery_duration_deg.unwrap(),
                0.0,
                1.0,
            ))
        } else {
            prescribed
        }
    }
    fn burn_angle(&self, fraction: f64) -> f64 {
        if let Some(start) = self.c.fuel_delivery_start_deg {
            let mut lo = self.soc.min(start);
            let mut hi = (self.soc + self.c.burn_duration_deg)
                .max(start + self.c.fuel_delivery_duration_deg.unwrap());
            for _ in 0..60 {
                let mid = (lo + hi) / 2.0;
                if self.wiebe(mid) < fraction {
                    lo = mid
                } else {
                    hi = mid
                }
            }
            return (lo + hi) / 2.0;
        }
        self.soc
            + self.c.burn_duration_deg
                * (-(1.0 - fraction * (1.0 - (-self.c.wiebe_efficiency).exp())).ln()
                    / self.c.wiebe_efficiency)
                    .powf(1.0 / (self.c.wiebe_shape + 1.0))
    }
    fn valid(&self, angle: f64, s: State) -> bool {
        let legacy = matches!(self.props, Props::Legacy { .. });
        s.m > 1e-12
            && (s.u > 0.0 || !legacy)
            && (s.m + s.u + s.fresh).is_finite()
            && s.fresh >= -1e-12
            && s.fresh <= s.m + 1e-12
            && self.state_temperature(angle, s) > 1.0
            && self.state_temperature(angle, s) < 20000.0
    }
    fn rates(&self, angle: f64, s: State, q_per_deg: f64) -> Result<Rates, String> {
        let c = self.c;
        let y = self.fresh_fraction(angle, s);
        let t = self.temperature(s.m, s.u, y);
        let v = cylinder_volume(c, angle);
        let p = s.m * self.gas_r(y) * t / v;
        let ai = valve_effective_area(
            angle,
            c.intake_open_deg,
            c.intake_close_deg,
            c.intake_valve_diameter_m,
            c.intake_valve_lift_m,
            c.intake_valve_count,
        );
        let ae = valve_effective_area(
            angle,
            c.exhaust_open_deg,
            c.exhaust_close_deg,
            c.exhaust_valve_diameter_m,
            c.exhaust_valve_lift_m,
            c.exhaust_valve_count,
        );
        // Each stream uses its upstream state: fresh air from the intake, burned
        // products from the exhaust reservoir, or the current cylinder mixture.
        let (ti, yi) = if p < c.intake_pressure_pa {
            (c.intake_temperature_k, 1.0)
        } else {
            (t, y)
        };
        let (te, ye) = if p > c.exhaust_pressure_pa {
            (t, y)
        } else {
            (c.exhaust_temperature_k, 0.0)
        };
        let gi = self.gamma_at(ti, yi);
        let ge = self.gamma_at(te, ye);
        let din = compressible_orifice_flow(
            c.intake_pressure_pa,
            c.intake_temperature_k,
            p,
            t,
            ai,
            c.discharge_coefficient,
            gi,
            self.gas_r(yi),
        )?;
        let dout = compressible_orifice_flow(
            p,
            t,
            c.exhaust_pressure_pa,
            c.exhaust_temperature_k,
            ae,
            c.discharge_coefficient,
            ge,
            self.gas_r(ye),
        )?;
        let incoming = (if din > 0.0 {
            din * self.enthalpy(c.intake_temperature_k, 1.0)
        } else {
            0.0
        }) + (if dout < 0.0 {
            -dout * self.enthalpy(c.exhaust_temperature_k, 0.0)
        } else {
            0.0
        });
        let outgoing = (if din < 0.0 {
            -din * self.enthalpy(t, y)
        } else {
            0.0
        }) + (if dout > 0.0 {
            dout * self.enthalpy(t, y)
        } else {
            0.0
        });
        let frac = clamp(s.fresh / s.m, 0.0, 1.0);
        let dfresh = (if din > 0.0 { din } else { din * frac })
            - (if dout > 0.0 { dout * frac } else { 0.0 });
        let area =
            2.0 * PI * c.bore_m.powi(2) / 4.0 + PI * c.bore_m * (v / (PI * c.bore_m.powi(2) / 4.0));
        let htc = self.heat_transfer_coefficient(angle, p, t, v);
        let qw = htc * area * (t - c.wall_temperature_k) * self.dt_per_deg;
        let work = p * volume_derivative(c, angle);
        Ok(Rates {
            dm: (din - dout) * self.dt_per_deg,
            du: q_per_deg - qw - work + (incoming - outgoing) * self.dt_per_deg,
            dfresh: dfresh * self.dt_per_deg,
            din,
            dout,
            hin: incoming * self.dt_per_deg,
            hout: outgoing * self.dt_per_deg,
            work,
            wall: qw,
            temp: t,
            pressure: p,
            htc,
        })
    }
    fn record(
        &self,
        trace: &mut CylinderCycleTrace,
        state: State,
        angle: f64,
        q_per_deg: f64,
        heat: f64,
    ) -> Result<f64, String> {
        let r = self.rates(angle, state, q_per_deg)?;
        trace.angle_deg.push(angle);
        trace.pressure_pa.push(r.pressure);
        trace.temperature_k.push(r.temp);
        trace.volume_m3.push(cylinder_volume(self.c, angle));
        trace.mass_kg.push(state.m);
        trace.heat_release_j.push(heat);
        trace.heat_release_rate_j_per_deg.push(q_per_deg);
        trace.intake_flow_kgs.push(r.din);
        trace.exhaust_flow_kgs.push(r.dout);
        Ok(r.htc)
    }
}

/// Spark-to-SOC offset that places Wiebe CA10 `spark_to_ca10_deg` after the spark.
/// A spark-to-CA10 delay is not a SOC shift: subtract the intrinsic SOC-to-CA10
/// interval of the configured Wiebe curve. Inputs must be finite, the delay
/// nonnegative, and the curve parameters within the cycle kernel's domain.
/// The resulting offset must also fit the kernel's -20..=60 degree range.
pub fn spark_to_soc_from_ca10_delay(
    spark_to_ca10_deg: f64,
    burn_duration_deg: f64,
    wiebe_efficiency: f64,
    wiebe_shape: f64,
) -> Result<f64, String> {
    if !spark_to_ca10_deg.is_finite() || spark_to_ca10_deg < 0.0 {
        return Err("sparkToCa10Deg must be finite and nonnegative".into());
    }
    for (name, value, min, max) in [
        ("burnDurationDeg", burn_duration_deg, 8.0, 120.0),
        ("wiebeEfficiency", wiebe_efficiency, 1.0, 12.0),
        ("wiebeShape", wiebe_shape, 0.1, 5.0),
    ] {
        if !value.is_finite() || !(min..=max).contains(&value) {
            return Err(format!("{name} must be finite and in {min}..={max}"));
        }
    }
    let soc_to_ca10 = burn_duration_deg
        * (-(1.0 - 0.1 * (1.0 - (-wiebe_efficiency).exp())).ln() / wiebe_efficiency)
            .powf(1.0 / (wiebe_shape + 1.0));
    let offset = spark_to_ca10_deg - soc_to_ca10;
    if !offset.is_finite() || !(-20.0..=60.0).contains(&offset) {
        return Err("resulting sparkToSocDeg must be finite and in -20..=60".into());
    }
    Ok(offset)
}

pub fn solve_cylinder_cycle(input: &CylinderCycleConfig) -> Result<CylinderCycleResult, String> {
    let c = input.clone().normalize()?;
    let nasa = c.property_model == PropertyModel::Nasa7FixedComposition;
    let chemistry = FuelChemistry {
        hydrogen_carbon: c.fuel_hydrogen_carbon_ratio,
        oxygen_carbon: c.fuel_oxygen_carbon_ratio,
    };
    let stoich_afr = chemistry.stoich_afr();
    let props = if nasa {
        Props::Nasa {
            air: Mixture::air(),
            burned: chemistry.products(stoich_afr / c.air_fuel_ratio, c.fuel_lhv_jkg).mixture,
        }
    } else {
        let cv_reference = R / (c.gamma - 1.0);
        let slope = if c.variable_heat_capacity { 0.12 } else { 0.0 };
        Props::Legacy {
            b: cv_reference - 300.0 * slope,
            slope,
        }
    };
    let soc = c
        .combustion_start_deg
        .unwrap_or(360.0 - c.spark_advance_deg + c.spark_to_soc_deg);
    let swept = PI * c.bore_m.powi(2) / 4.0 * c.stroke_m;
    let mut model = Model {
        c: &c,
        props,
        dt_per_deg: 1.0 / (6.0 * c.rpm),
        soc,
        burn_end: soc + c.burn_duration_deg,
        swept,
        mean_piston_speed: 2.0 * c.stroke_m * c.rpm / 60.0,
        ivc_state: None,
    };
    let burn_end = model.burn_end;
    let initial_volume = cylinder_volume(&c, 0.0);
    let mut state = State {
        m: c.initial_pressure_pa * initial_volume / (model.gas_r(0.0) * c.initial_temperature_k),
        u: 0.0,
        fresh: 0.0,
    };
    state.u = state.m * model.specific_u(c.initial_temperature_k, 0.0);
    let (mut cycle_phi, mut released_fraction, mut peak_htc) = (None, None, 0.0_f64);
    let mut trace = CylinderCycleTrace::default();
    let (mut net, mut gross, mut pumping, mut heat, mut wall) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut in_mass, mut in_reverse, mut out_mass, mut out_reverse) = (0.0, 0.0, 0.0, 0.0);
    let (mut hin, mut hout, mut out_temperature) = (0.0, 0.0, 0.0);
    let mut steps = 0;
    let (mut fuel, mut fresh_charge, mut residual) = (0.0, 0.0, 1.0);
    let mut oxygen_eligible_fuel = 0.0;
    let (mut peak_pressure, mut peak_temp, mut peak_angle, mut max_rise) =
        (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    let (mut initial_m, mut initial_u) = (0.0, 0.0);
    let mut events = vec![
        c.intake_close_deg,
        model.soc,
        burn_end,
        180.0,
        360.0,
        540.0,
        c.exhaust_open_deg,
        720.0,
    ];
    if let Some(start) = c.fuel_delivery_start_deg {
        events.push(start);
        events.push(start + c.fuel_delivery_duration_deg.unwrap());
    }
    events.sort_by(f64::total_cmp);
    let cycles = c.settling_cycles as usize;
    for cycle in 0..=cycles {
        let capturing = cycle == cycles;
        if capturing {
            initial_m = state.m;
            initial_u = state.u;
            net = 0.0;
            gross = 0.0;
            pumping = 0.0;
            heat = 0.0;
            wall = 0.0;
            in_mass = 0.0;
            in_reverse = 0.0;
            out_mass = 0.0;
            out_reverse = 0.0;
            hin = 0.0;
            hout = 0.0;
            out_temperature = 0.0;
            steps = 0;
            peak_htc = model.record(&mut trace, state, 0.0, 0.0, heat)?;
            peak_pressure = trace.pressure_pa[0];
            peak_temp = trace.temperature_k[0];
            peak_angle = 0.0;
        }
        let mut angle = 0.0;
        let (mut ivc_captured, mut burn_tagged) = (false, false);
        let mut cycle_fuel = c.fuel_mass_kg.unwrap_or(0.0);
        let mut cycle_heat_fuel = cycle_fuel;
        let (mut cycle_fresh, mut cycle_residual) = (0.0, 1.0);
        let bins = (720.0 / c.step_deg).round() as usize;
        for sample in 1..=bins {
            let target = if sample == bins {
                720.0
            } else {
                sample as f64 * c.step_deg
            };
            while angle < target - 1e-9 {
                if !ivc_captured && angle >= c.intake_close_deg - 1e-9 {
                    cycle_fresh = state.fresh;
                    cycle_residual = clamp(1.0 - state.fresh / state.m, 0.0, 1.0);
                    cycle_fuel = c.fuel_mass_kg.unwrap_or(cycle_fresh / c.air_fuel_ratio);
                    cycle_heat_fuel = c
                        .oxygen_limit_afr
                        .map(|afr| cycle_fuel.min(cycle_fresh.max(0.0) / afr))
                        .unwrap_or(cycle_fuel);
                    if nasa {
                        // Products follow this cycle's trapped air and fuel; rich
                        // products retain CO/H2 heating value (never above the cap).
                        let phi = if cycle_fresh > 0.0 {
                            cycle_fuel / cycle_fresh * stoich_afr
                        } else {
                            stoich_afr / c.air_fuel_ratio
                        };
                        let products = chemistry.products(clamp(phi, 1e-3, 3.0), c.fuel_lhv_jkg);
                        cycle_heat_fuel = cycle_heat_fuel.min(cycle_fuel * products.released_fraction);
                        if let Props::Nasa { burned, .. } = &mut model.props {
                            *burned = products.mixture;
                        }
                        cycle_phi = Some(products.phi);
                        released_fraction = Some(products.released_fraction);
                    }
                    if c.heat_transfer_model == HeatTransferModel::Woschni {
                        let y = model.fresh_fraction(angle, state);
                        let t = model.temperature(state.m, state.u, y);
                        model.ivc_state = Some((
                            model.state_pressure(angle, state),
                            cylinder_volume(&c, angle),
                            t,
                            model.gamma_at(t, y),
                        ));
                    }
                    ivc_captured = true;
                }
                // Tracer conversion changes neither total gas mass nor energy.
                // NASA mode converts composition progressively and clears the
                // tracer at burn end; legacy clears it at SOC.
                if !burn_tagged && angle >= if nasa { burn_end } else { model.soc } - 1e-9 {
                    state.fresh = 0.0;
                    burn_tagged = true;
                }
                let mut h = 0.25_f64.min(c.step_deg / 4.0).min(target - angle);
                for &event in &events {
                    if event > angle + 1e-9 && event < angle + h {
                        h = event - angle;
                    }
                }
                let mut accepted = false;
                for _ in 0..18 {
                    let q = cycle_heat_fuel
                        * c.fuel_lhv_jkg
                        * c.combustion_efficiency
                        * (model.wiebe(angle + h) - model.wiebe(angle))
                        / h;
                    let first = model.rates(angle, state, q)?;
                    let mid = State {
                        m: state.m + first.dm * h / 2.0,
                        u: state.u + first.du * h / 2.0,
                        fresh: state.fresh + first.dfresh * h / 2.0,
                    };
                    if !model.valid(angle + h / 2.0, mid)
                        || (first.dm * h).abs() > state.m * 0.08
                        // NASA sensible u is ~0 near 298 K; bound steps by a cv*T scale.
                        || (first.du * h).abs()
                            > if nasa { state.u.abs().max(state.m * 2e5) } else { state.u } * 0.25
                    {
                        h /= 2.0;
                        continue;
                    }
                    let r = model.rates(angle + h / 2.0, mid, q)?;
                    let next = State {
                        m: state.m + r.dm * h,
                        u: state.u + r.du * h,
                        fresh: state.fresh + r.dfresh * h,
                    };
                    if !model.valid(angle + h, next) {
                        h /= 2.0;
                        continue;
                    }
                    let old_p = model.state_pressure(angle, state);
                    let new_p = model.state_pressure(angle + h, next);
                    if capturing {
                        let w = r.work * h;
                        net += w;
                        if angle + h / 2.0 >= 180.0 && angle + h / 2.0 <= 540.0 {
                            gross += w
                        } else {
                            pumping += w
                        }
                        heat += q * h;
                        wall += r.wall * h;
                        hin += r.hin * h;
                        hout += r.hout * h;
                        let dt = h * model.dt_per_deg;
                        if r.din >= 0.0 {
                            in_mass += r.din * dt
                        } else {
                            in_reverse -= r.din * dt
                        }
                        if r.dout >= 0.0 {
                            out_mass += r.dout * dt;
                            out_temperature += r.dout * dt * r.temp
                        } else {
                            out_reverse -= r.dout * dt
                        }
                        max_rise = max_rise.max((new_p - old_p) / h);
                        if new_p > peak_pressure {
                            peak_pressure = new_p;
                            peak_angle = angle + h;
                        }
                        peak_temp = peak_temp.max(model.state_temperature(angle + h, next));
                        peak_htc = peak_htc.max(r.htc);
                        steps += 1;
                    }
                    state = next;
                    angle += h;
                    accepted = true;
                    break;
                }
                if !accepted {
                    return Err(format!(
                        "Cylinder integration left its valid state domain near {angle:.3} crank degrees."
                    ));
                }
            }
            if capturing {
                let q = cycle_heat_fuel
                    * c.fuel_lhv_jkg
                    * c.combustion_efficiency
                    * (model.wiebe((target + 0.001).min(720.0))
                        - model.wiebe((target - 0.001).max(0.0)))
                    / 0.002;
                peak_htc = peak_htc.max(model.record(&mut trace, state, target, q, heat)?);
            }
        }
        if capturing {
            fuel = cycle_fuel;
            oxygen_eligible_fuel = cycle_heat_fuel;
            fresh_charge = cycle_fresh;
            residual = cycle_residual;
        }
    }
    let mass_residual = state.m - initial_m - (in_mass + out_reverse - in_reverse - out_mass);
    let energy_residual = state.u - initial_u - (heat - wall - net + hin - hout);
    let periodic_mass_relative_error = (state.m - initial_m).abs() / initial_m.max(1e-12);
    let periodic_energy_relative_error = (state.u - initial_u).abs() / initial_u.max(1e-12);
    let mut warnings = Vec::new();
    if periodic_mass_relative_error > 0.02 || periodic_energy_relative_error > 0.02 {
        warnings.push("Cycle is not settled to within 2% mass/internal-energy closure; increase settling cycles or inspect boundary conditions.".into());
    }
    if burn_end >= c.exhaust_open_deg {
        warnings.push("Specified heat release overlaps exhaust opening; unburned-fuel discharge/chemistry is not resolved.".into());
    }
    if model.soc < c.intake_close_deg && c.combustion_start_deg.is_none() {
        warnings.push("Prescribed SI heat release starts before intake valve closure; trapped-charge and fuel accounting are not meaningful.".into());
    }
    if nasa {
        warnings.push("Uncalibrated single-zone model with fixed-composition NASA-7 properties (fresh air / complete products, water-gas shift when rich); fuel adds heat, not working-gas mass; no dissociation or emissions.".into());
    } else {
        warnings.push("Uncalibrated air-standard single-zone model; fuel is represented by heat input and residual gas uses the same working-fluid properties.".into());
    }
    if c.heat_transfer_model == HeatTransferModel::Woschni {
        warnings.push("Woschni wall heat transfer uses its generic published constants with one bulk gas and one wall temperature; this chamber's coefficient is not identified.".into());
    }
    if c.variable_heat_capacity && !nasa {
        warnings.push("Temperature-dependent heat capacity is an explicit linear air approximation, not chemical equilibrium or a validated gas-property table.".into());
    }
    for &p in &trace.pressure_pa {
        peak_pressure = peak_pressure.max(p)
    }
    for &t in &trace.temperature_k {
        peak_temp = peak_temp.max(t)
    }
    let result = CylinderCycleResult {
        config: c.clone(),
        oxygen_limited_fuel_mass_kg: c.oxygen_limit_afr.map(|_| oxygen_eligible_fuel),
        oxygen_unburned_fuel_mass_kg: c
            .oxygen_limit_afr
            .map(|_| (fuel - oxygen_eligible_fuel).max(0.0)),
        trace,
        net_work_j: net,
        net_indicated_work_j: net,
        gross_work_j: gross,
        pumping_work_j: pumping,
        imep_pa: net / swept,
        peak_pressure_pa: peak_pressure,
        peak_temperature_k: peak_temp,
        peak_pressure_angle_deg: peak_angle,
        peak_pressure_rise_pa_per_deg: max_rise,
        ca10_deg: model.burn_angle(0.1),
        ca50_deg: model.burn_angle(0.5),
        ca90_deg: model.burn_angle(0.9),
        soc_deg: model.soc,
        peak_heat_transfer_wm2_k: peak_htc,
        burned_gas_equivalence_ratio: cycle_phi,
        released_lhv_fraction: released_fraction,
        fresh_charge_mass_kg: fresh_charge,
        air_mass_kg: fresh_charge,
        fuel_mass_kg: fuel,
        fuel_energy_j: fuel * c.fuel_lhv_jkg,
        released_heat_j: heat,
        residual_fraction_at_ivc: residual,
        wall_heat_loss_j: wall,
        intake_mass_in_kg: in_mass,
        intake_reverse_mass_kg: in_reverse,
        exhaust_mass_kg: out_mass,
        exhaust_reverse_mass_kg: out_reverse,
        exhaust_temperature_k: if out_mass > 0.0 {
            out_temperature / out_mass
        } else {
            c.exhaust_temperature_k
        },
        inlet_enthalpy_j: hin,
        outlet_enthalpy_j: hout,
        mass_balance_residual_kg: mass_residual,
        energy_balance_residual_j: energy_residual,
        periodic_mass_relative_error,
        periodic_energy_relative_error,
        initial_mass_kg: initial_m,
        final_mass_kg: state.m,
        initial_internal_energy_j: initial_u,
        final_internal_energy_j: state.u,
        steps,
        warnings,
        status: if nasa {
            "uncalibrated-fixed-composition"
        } else {
            "uncalibrated-air-standard"
        }
        .into(),
    };
    Ok(result)
}
