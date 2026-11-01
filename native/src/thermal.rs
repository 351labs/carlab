//! Original v4 lumped thermal-network model port. Gas and metal are distinct.
use serde::{Deserialize, Serialize};
use serde_json::Value;
fn number(v: &Value, k: &str, d: f64, lo: f64, hi: f64) -> f64 {
    match v.get(k).and_then(Value::as_f64) {
        Some(n) if n.is_finite() => n.clamp(lo, hi),
        _ => d,
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ThermalConfig {
    pub provenance: String,
    pub source: String,
    pub ambient_temperature_k: f64,
    pub initial_wall_temperature_k: f64,
    pub initial_coolant_temperature_k: f64,
    pub initial_oil_temperature_k: f64,
    pub initial_exhaust_wall_temperature_k: f64,
    #[serde(rename = "wallHeatCapacityJK")]
    pub wall_heat_capacity_jk: f64,
    #[serde(rename = "coolantHeatCapacityJK")]
    pub coolant_heat_capacity_jk: f64,
    #[serde(rename = "oilHeatCapacityJK")]
    pub oil_heat_capacity_jk: f64,
    #[serde(rename = "exhaustWallHeatCapacityJK")]
    pub exhaust_wall_heat_capacity_jk: f64,
    #[serde(rename = "wallToCoolantWK")]
    pub wall_to_coolant_wk: f64,
    #[serde(rename = "wallToOilWK")]
    pub wall_to_oil_wk: f64,
    #[serde(rename = "wallToExhaustWK")]
    pub wall_to_exhaust_wk: f64,
    #[serde(rename = "exhaustToCoolantWK")]
    pub exhaust_to_coolant_wk: f64,
    #[serde(rename = "coolantToAmbientWK")]
    pub coolant_to_ambient_wk: f64,
    #[serde(rename = "oilToAmbientWK")]
    pub oil_to_ambient_wk: f64,
    #[serde(rename = "exhaustToAmbientWK")]
    pub exhaust_to_ambient_wk: f64,
    pub coolant_mass_flow_kgs: f64,
    #[serde(rename = "coolantSpecificHeatJKgK")]
    pub coolant_specific_heat_jkg_k: f64,
    pub coolant_inlet_temperature_k: f64,
    pub oil_mass_flow_kgs: f64,
    #[serde(rename = "oilSpecificHeatJKgK")]
    pub oil_specific_heat_jkg_k: f64,
    pub oil_inlet_temperature_k: f64,
    pub friction_to_oil_fraction: f64,
    #[serde(rename = "exhaustGasHeatCapacityJKgK")]
    pub exhaust_gas_heat_capacity_jkg_k: f64,
    pub exhaust_heat_transfer_effectiveness: f64,
}
impl Default for ThermalConfig {
    fn default() -> Self {
        normalize_thermal_config(&Value::Null)
    }
}
impl ThermalConfig {
    pub fn normalize(v: &Value) -> Self {
        normalize_thermal_config(v)
    }
    fn normalized(&self) -> Self {
        normalize_thermal_config(&serde_json::to_value(self).unwrap_or(Value::Null))
    }
}
pub fn normalize_thermal_config(s: &Value) -> ThermalConfig {
    ThermalConfig {
        provenance: match s.get("provenance").and_then(Value::as_str) {
            Some("fitted") => "fitted",
            Some("measured") => "measured",
            _ => "assumed",
        }
        .into(),
        source: s
            .get("source")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(2000).collect())
            .unwrap_or_else(|| "Hipóteses de demonstração; modelo sem calibração.".into()),
        ambient_temperature_k: number(s, "ambientTemperatureK", 293.15, 200.0, 400.0),
        initial_wall_temperature_k: number(s, "initialWallTemperatureK", 353.15, 200.0, 1800.0),
        initial_coolant_temperature_k: number(
            s,
            "initialCoolantTemperatureK",
            343.15,
            200.0,
            700.0,
        ),
        initial_oil_temperature_k: number(s, "initialOilTemperatureK", 343.15, 200.0, 900.0),
        initial_exhaust_wall_temperature_k: number(
            s,
            "initialExhaustWallTemperatureK",
            473.15,
            200.0,
            2000.0,
        ),
        wall_heat_capacity_jk: number(s, "wallHeatCapacityJK", 25000.0, 100.0, 5e6),
        coolant_heat_capacity_jk: number(s, "coolantHeatCapacityJK", 18000.0, 100.0, 5e6),
        oil_heat_capacity_jk: number(s, "oilHeatCapacityJK", 9000.0, 100.0, 5e6),
        exhaust_wall_heat_capacity_jk: number(s, "exhaustWallHeatCapacityJK", 4500.0, 100.0, 5e6),
        wall_to_coolant_wk: number(s, "wallToCoolantWK", 180.0, 0.0, 20000.0),
        wall_to_oil_wk: number(s, "wallToOilWK", 35.0, 0.0, 20000.0),
        wall_to_exhaust_wk: number(s, "wallToExhaustWK", 8.0, 0.0, 20000.0),
        exhaust_to_coolant_wk: number(s, "exhaustToCoolantWK", 5.0, 0.0, 20000.0),
        coolant_to_ambient_wk: number(s, "coolantToAmbientWK", 35.0, 0.0, 20000.0),
        oil_to_ambient_wk: number(s, "oilToAmbientWK", 18.0, 0.0, 20000.0),
        exhaust_to_ambient_wk: number(s, "exhaustToAmbientWK", 16.0, 0.0, 20000.0),
        coolant_mass_flow_kgs: number(s, "coolantMassFlowKgs", 0.25, 0.0, 20.0),
        coolant_specific_heat_jkg_k: number(s, "coolantSpecificHeatJKgK", 4180.0, 500.0, 8000.0),
        coolant_inlet_temperature_k: number(s, "coolantInletTemperatureK", 333.15, 200.0, 700.0),
        oil_mass_flow_kgs: number(s, "oilMassFlowKgs", 0.15, 0.0, 20.0),
        oil_specific_heat_jkg_k: number(s, "oilSpecificHeatJKgK", 2000.0, 500.0, 8000.0),
        oil_inlet_temperature_k: number(s, "oilInletTemperatureK", 343.15, 200.0, 900.0),
        friction_to_oil_fraction: number(s, "frictionToOilFraction", 0.7, 0.0, 1.0),
        exhaust_gas_heat_capacity_jkg_k: number(
            s,
            "exhaustGasHeatCapacityJKgK",
            1100.0,
            500.0,
            3000.0,
        ),
        exhaust_heat_transfer_effectiveness: number(
            s,
            "exhaustHeatTransferEffectiveness",
            0.18,
            0.0,
            1.0,
        ),
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThermalLoads {
    pub gas_heat_w: Option<f64>,
    pub friction_heat_w: Option<f64>,
    pub exhaust_heat_w: Option<f64>,
    pub coupled_exhaust_gas_heat_w: Option<f64>,
    pub exhaust_gas_temperature_k: Option<f64>,
    pub exhaust_mass_flow_kgs: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThermalState {
    pub wall_temperature_k: f64,
    pub coolant_temperature_k: f64,
    pub oil_temperature_k: f64,
    pub exhaust_wall_temperature_k: f64,
    pub exhaust_gas_temperature_k: f64,
    pub elapsed_seconds: f64,
    pub stored_energy_j: f64,
    pub delta_stored_energy_j: f64,
    pub cumulative_input_j: f64,
    pub cumulative_rejected_j: f64,
    pub ambient_rejected_j: f64,
    pub fluid_rejected_j: f64,
    pub energy_residual_j: f64,
    pub exhaust_gas_to_wall_heat_w: f64,
    pub status: String,
}
impl Default for ThermalState {
    fn default() -> Self {
        Self {
            wall_temperature_k: 0.0,
            coolant_temperature_k: 0.0,
            oil_temperature_k: 0.0,
            exhaust_wall_temperature_k: 0.0,
            exhaust_gas_temperature_k: 0.0,
            elapsed_seconds: 0.0,
            stored_energy_j: 0.0,
            delta_stored_energy_j: 0.0,
            cumulative_input_j: 0.0,
            cumulative_rejected_j: 0.0,
            ambient_rejected_j: 0.0,
            fluid_rejected_j: 0.0,
            energy_residual_j: 0.0,
            exhaust_gas_to_wall_heat_w: 0.0,
            status: "unvalidated-lumped-model".into(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct ThermalNetwork {
    config: ThermalConfig,
    temperature: [f64; 4],
    capacity: [f64; 4],
    reference_energy: f64,
    input_j: f64,
    ambient_j: f64,
    fluid_j: f64,
    elapsed: f64,
    gas_temperature: f64,
    gas_to_wall_w: f64,
}
impl ThermalNetwork {
    pub fn new(config: ThermalConfig) -> Self {
        let mut net = Self {
            config: config.normalized(),
            temperature: [0.0; 4],
            capacity: [0.0; 4],
            reference_energy: 0.0,
            input_j: 0.0,
            ambient_j: 0.0,
            fluid_j: 0.0,
            elapsed: 0.0,
            gas_temperature: 293.15,
            gas_to_wall_w: 0.0,
        };
        net.update_capacities();
        net.reset();
        net
    }
    fn update_capacities(&mut self) {
        let c = &self.config;
        self.capacity = [
            c.wall_heat_capacity_jk,
            c.coolant_heat_capacity_jk,
            c.oil_heat_capacity_jk,
            c.exhaust_wall_heat_capacity_jk,
        ];
    }
    fn energy(&self) -> f64 {
        let mut sum = 0.0;
        for i in 0..4 {
            sum += self.temperature[i] * self.capacity[i];
        }
        sum
    }
    fn rebase(&mut self) {
        self.reference_energy = self.energy();
        self.input_j = 0.0;
        self.ambient_j = 0.0;
        self.fluid_j = 0.0;
        self.elapsed = 0.0;
        self.gas_to_wall_w = 0.0;
    }
    pub fn set_config(&mut self, config: ThermalConfig) {
        let next = config.normalized();
        if next == self.config {
            return;
        }
        let previous = self.config.clone();
        let reset = next.initial_wall_temperature_k != previous.initial_wall_temperature_k
            || next.initial_coolant_temperature_k != previous.initial_coolant_temperature_k
            || next.initial_oil_temperature_k != previous.initial_oil_temperature_k
            || next.initial_exhaust_wall_temperature_k
                != previous.initial_exhaust_wall_temperature_k;
        let mut physical = next.clone();
        physical.source = previous.source.clone();
        physical.provenance = previous.provenance.clone();
        let physical_change = physical != previous;
        self.config = next;
        self.update_capacities();
        if reset {
            self.reset();
        } else if physical_change {
            self.rebase();
        }
    }
    pub fn reset(&mut self) -> ThermalState {
        let c = &self.config;
        self.temperature = [
            c.initial_wall_temperature_k,
            c.initial_coolant_temperature_k,
            c.initial_oil_temperature_k,
            c.initial_exhaust_wall_temperature_k,
        ];
        self.gas_temperature = c.ambient_temperature_k;
        self.rebase();
        self.get_state()
    }
    pub fn get_state(&self) -> ThermalState {
        let stored_energy_j = self.energy();
        let cumulative_rejected_j = self.ambient_j + self.fluid_j;
        ThermalState {
            wall_temperature_k: self.temperature[0],
            coolant_temperature_k: self.temperature[1],
            oil_temperature_k: self.temperature[2],
            exhaust_wall_temperature_k: self.temperature[3],
            exhaust_gas_temperature_k: self.gas_temperature,
            elapsed_seconds: self.elapsed,
            stored_energy_j,
            delta_stored_energy_j: stored_energy_j - self.reference_energy,
            cumulative_input_j: self.input_j,
            cumulative_rejected_j,
            ambient_rejected_j: self.ambient_j,
            fluid_rejected_j: self.fluid_j,
            energy_residual_j: stored_energy_j - self.reference_energy - self.input_j
                + cumulative_rejected_j,
            exhaust_gas_to_wall_heat_w: self.gas_to_wall_w,
            status: "unvalidated-lumped-model".into(),
        }
    }
    fn exchange(&mut self, a: usize, b: usize, g: f64, h: f64) {
        if g == 0.0 {
            return;
        }
        let ca = self.capacity[a];
        let cb = self.capacity[b];
        let q = (self.temperature[a] - self.temperature[b]) / (1.0 / ca + 1.0 / cb)
            * (-(-g * (1.0 / ca + 1.0 / cb) * h).exp_m1());
        self.temperature[a] -= q / ca;
        self.temperature[b] += q / cb;
    }
    fn boundary(&mut self, node: usize, t: f64, g: f64, h: f64) -> f64 {
        if g == 0.0 {
            return 0.0;
        }
        let q = self.capacity[node]
            * (self.temperature[node] - t)
            * (-(-g * h / self.capacity[node]).exp_m1());
        self.temperature[node] -= q / self.capacity[node];
        q
    }
    pub fn step(&mut self, dt: f64, loads: &ThermalLoads) -> Result<ThermalState, String> {
        if !dt.is_finite() || dt <= 0.0 {
            return Ok(self.get_state());
        }
        if dt > 60.0 {
            return Err("Use passos térmicos de até 60 segundos.".into());
        }
        fn load(value: Option<f64>, fallback: f64, key: &str) -> Result<f64, String> {
            let v = value.unwrap_or(fallback);
            if v.is_finite() {
                Ok(v)
            } else {
                Err(format!("Carga térmica inválida: {key}"))
            }
        }
        let gas_heat_w = load(loads.gas_heat_w, 0.0, "gasHeatW")?;
        let friction_heat_w = load(loads.friction_heat_w, 0.0, "frictionHeatW")?;
        let exhaust_heat_w = load(loads.exhaust_heat_w, 0.0, "exhaustHeatW")?;
        let coupled = load(
            loads.coupled_exhaust_gas_heat_w,
            0.0,
            "coupledExhaustGasHeatW",
        )?;
        let mass_flow = load(loads.exhaust_mass_flow_kgs, 0.0, "exhaustMassFlowKgs")?;
        let gas_temperature = load(
            loads.exhaust_gas_temperature_k,
            self.gas_temperature,
            "exhaustGasTemperatureK",
        )?;
        if friction_heat_w < 0.0 || mass_flow < 0.0 || gas_temperature <= 0.0 {
            return Err(
                "Atrito/vazão devem ser não negativos e temperatura absoluta positiva.".into(),
            );
        }
        let c = self.config.clone();
        let steps = (dt / 0.05).ceil() as usize;
        let h = dt / steps as f64;
        let before = self.temperature;
        let old_input = self.input_j;
        let old_ambient = self.ambient_j;
        let old_fluid = self.fluid_j;
        let mut gas_to_wall_j = coupled * dt;
        for _ in 0..steps {
            self.temperature[0] += gas_heat_w * h / self.capacity[0];
            self.temperature[1] +=
                friction_heat_w * (1.0 - c.friction_to_oil_fraction) * h / self.capacity[1];
            self.temperature[2] +=
                friction_heat_w * c.friction_to_oil_fraction * h / self.capacity[2];
            self.temperature[3] += (exhaust_heat_w + coupled) * h / self.capacity[3];
            self.input_j += (gas_heat_w + friction_heat_w + exhaust_heat_w + coupled) * h;
            let gas_boundary_q = self.boundary(
                3,
                gas_temperature,
                mass_flow
                    * c.exhaust_gas_heat_capacity_jkg_k
                    * c.exhaust_heat_transfer_effectiveness,
                h,
            );
            gas_to_wall_j -= gas_boundary_q;
            self.input_j -= gas_boundary_q;
            self.exchange(0, 1, c.wall_to_coolant_wk, h);
            self.exchange(0, 2, c.wall_to_oil_wk, h);
            self.exchange(0, 3, c.wall_to_exhaust_wk, h);
            self.exchange(3, 1, c.exhaust_to_coolant_wk, h);
            let fluid_a = self.boundary(
                1,
                c.coolant_inlet_temperature_k,
                c.coolant_mass_flow_kgs * c.coolant_specific_heat_jkg_k,
                h,
            );
            let fluid_b = self.boundary(
                2,
                c.oil_inlet_temperature_k,
                c.oil_mass_flow_kgs * c.oil_specific_heat_jkg_k,
                h,
            );
            self.fluid_j += fluid_a + fluid_b;
            let ambient_a = self.boundary(1, c.ambient_temperature_k, c.coolant_to_ambient_wk, h);
            let ambient_b = self.boundary(2, c.ambient_temperature_k, c.oil_to_ambient_wk, h);
            let ambient_c = self.boundary(3, c.ambient_temperature_k, c.exhaust_to_ambient_wk, h);
            self.ambient_j += ambient_a + ambient_b + ambient_c;
            if !self
                .temperature
                .iter()
                .all(|value| value.is_finite() && *value > 0.0)
            {
                self.temperature = before;
                self.input_j = old_input;
                self.ambient_j = old_ambient;
                self.fluid_j = old_fluid;
                return Err("Estado térmico não físico: verifique cargas e capacidades.".into());
            }
        }
        self.elapsed += dt;
        self.gas_temperature = gas_temperature;
        self.gas_to_wall_w = gas_to_wall_j / dt;
        Ok(self.get_state())
    }
}
