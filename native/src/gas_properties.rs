//! Fixed-composition ideal-gas properties for the cylinder kernel (model 3).
//!
//! Species data: NASA-7 polynomials from McBride, Gordon & Reno (1993), NASA
//! TM-4513, as redistributed in Cantera v3.1.0 `data/nasa_gas.yaml`
//! (BSD-3-Clause; full notice in licenses/cantera-BSD-3-Clause.txt at repo root;
//! sha256 4de6199d65d2d3db782e30573720c723130953707336add59713b02d8667e4db).
//! Every species below shares the 200-1000-6000 K ranges; outside 200-6000 K the
//! property set is undefined and callers receive `None` (no extrapolation).
//! Energies are sensible values referenced to 298.15 K; fuel heat release is
//! supplied separately (LHV), so u/h/cp/R/stream enthalpy stay mutually coherent.
pub const RU: f64 = 8.314462618; // J/(mol K), CODATA 2018
pub const T_MIN: f64 = 200.0;
pub const T_MAX: f64 = 6000.0;
const T_MID: f64 = 1000.0;
const T_REF: f64 = 298.15;
/// Water-gas-shift freeze temperature for rich products (declared assumption).
pub const WGS_FREEZE_K: f64 = 1700.0;

#[derive(Clone, Copy)]
struct Species {
    molar_mass: f64, // kg/mol
    low: [f64; 7],
    high: [f64; 7],
}
const N2: Species = Species {
    molar_mass: 0.0280134,
    low: [3.53100528, -1.23660987e-04, -5.02999437e-07, 2.43530612e-09, -1.40881235e-12, -1046.97628, 2.96747468],
    high: [2.95257626, 1.39690057e-03, -4.92631691e-07, 7.86010367e-11, -4.60755321e-15, -923.948645, 5.87189252],
};
const O2: Species = Species {
    molar_mass: 0.0319988,
    low: [3.78245636, -2.99673415e-03, 9.847302e-06, -9.68129508e-09, 3.24372836e-12, -1063.94356, 3.65767573],
    high: [3.66096083, 6.56365523e-04, -1.41149485e-07, 2.05797658e-11, -1.29913248e-15, -1215.97725, 3.41536184],
};
const AR: Species = Species {
    molar_mass: 0.039948,
    low: [2.5, 0.0, 0.0, 0.0, 0.0, -745.375, 4.37967491],
    high: [2.5, 0.0, 0.0, 0.0, 0.0, -745.375, 4.37967491],
};
const CO2: Species = Species {
    molar_mass: 0.0440095,
    low: [2.35677352, 8.98459677e-03, -7.12356269e-06, 2.45919022e-09, -1.43699548e-13, -4.83719697e+04, 9.90105222],
    high: [4.63659493, 2.74131991e-03, -9.95828531e-07, 1.60373011e-10, -9.16103468e-15, -4.90249341e+04, -1.93534855],
};
const H2O: Species = Species {
    molar_mass: 0.0180153,
    low: [4.19864056, -2.0364341e-03, 6.52040211e-06, -5.48797062e-09, 1.77197817e-12, -3.02937267e+04, -0.849032208],
    high: [2.67703787, 2.97318329e-03, -7.7376969e-07, 9.44336689e-11, -4.26900959e-15, -2.98858938e+04, 6.88255571],
};
const CO: Species = Species {
    molar_mass: 0.0280101,
    low: [3.57953347, -6.1035368e-04, 1.01681433e-06, 9.07005884e-10, -9.04424499e-13, -1.4344086e+04, 3.50840928],
    high: [3.04848583, 1.35172818e-03, -4.85794075e-07, 7.88536486e-11, -4.69807489e-15, -1.42661171e+04, 6.0170979],
};
const H2: Species = Species {
    molar_mass: 0.00201588,
    low: [2.34433112, 7.98052075e-03, -1.9478151e-05, 2.01572094e-08, -7.37611761e-12, -917.935173, 0.683010238],
    high: [2.93286579, 8.26607967e-04, -1.46402335e-07, 1.54100359e-11, -6.88804432e-16, -813.065597, -1.02432887],
};
/// US Standard Atmosphere 1976 dry-air mole fractions (N2, O2, Ar, CO2).
const AIR: [(Species, f64); 4] = [(N2, 0.78084), (O2, 0.209476), (AR, 0.00934), (CO2, 0.000314)];
const M_C: f64 = 0.012011;
const M_H: f64 = 0.001008;
const M_O: f64 = 0.015999;

fn h_over_r(a: &[f64; 7], t: f64) -> f64 {
    t * (a[0] + t * (a[1] / 2.0 + t * (a[2] / 3.0 + t * (a[3] / 4.0 + t * a[4] / 5.0)))) + a[5]
}
fn s_over_r(a: &[f64; 7], t: f64) -> f64 {
    a[0] * t.ln() + t * (a[1] + t * (a[2] / 2.0 + t * (a[3] / 3.0 + t * a[4] / 4.0))) + a[6]
}
fn cp_over_r(a: &[f64; 7], t: f64) -> f64 {
    a[0] + t * (a[1] + t * (a[2] + t * (a[3] + t * a[4])))
}
fn coeffs(s: &Species, t: f64) -> &[f64; 7] {
    if t < T_MID { &s.low } else { &s.high }
}
/// Standard molar enthalpy (J/mol), including formation enthalpy at 298.15 K.
fn molar_h(s: &Species, t: f64) -> f64 {
    RU * h_over_r(coeffs(s, t), t)
}

/// One fixed composition: mole-weighted NASA-7 coefficients and mass-specific R.
#[derive(Clone, Debug, PartialEq)]
pub struct Mixture {
    pub gas_r: f64,
    low: [f64; 7],
    high: [f64; 7],
    h_ref: f64,
}
impl Mixture {
    fn from_moles(parts: &[(Species, f64)]) -> Self {
        let total: f64 = parts.iter().map(|p| p.1).sum();
        let (mut low, mut high, mut molar_mass) = ([0.0; 7], [0.0; 7], 0.0);
        for (s, n) in parts {
            let x = n / total;
            molar_mass += x * s.molar_mass;
            for i in 0..7 {
                low[i] += x * s.low[i];
                high[i] += x * s.high[i];
            }
        }
        // NASA fits match only approximately at 1000 K; shift the high-range
        // enthalpy constant so h(T) and u(T) are exactly continuous there.
        high[5] += h_over_r(&low, T_MID) - h_over_r(&high, T_MID);
        let mut m = Self { gas_r: RU / molar_mass, low, high, h_ref: 0.0 };
        m.h_ref = h_over_r(&m.low, T_REF);
        m
    }
    pub fn air() -> Self {
        Self::from_moles(&AIR)
    }
    fn poly(&self, t: f64) -> &[f64; 7] {
        if t < T_MID { &self.low } else { &self.high }
    }
    /// J/(kg K)
    pub fn cp(&self, t: f64) -> f64 {
        self.gas_r * cp_over_r(self.poly(t), t)
    }
    /// Sensible enthalpy, J/kg, zero at 298.15 K.
    pub fn h(&self, t: f64) -> f64 {
        self.gas_r * (h_over_r(self.poly(t), t) - self.h_ref)
    }
    /// Internal energy on the same sensible basis as `h` (h = 0 at 298.15 K), J/kg.
    /// u = h - R T keeps the flow work h - u = p/rho = R T of every valve stream.
    pub fn u(&self, t: f64) -> f64 {
        self.h(t) - self.gas_r * t
    }
}

/// Fuel CH_yO_z burned with dry air at equivalence ratio `phi` (fixed products).
#[derive(Clone, Debug, PartialEq)]
pub struct FuelChemistry {
    pub hydrogen_carbon: f64,
    pub oxygen_carbon: f64,
}
pub struct Products {
    pub mixture: Mixture,
    /// Fraction of fuel LHV released; <1 only when rich products keep CO/H2.
    pub released_fraction: f64,
    pub phi: f64,
}
impl FuelChemistry {
    fn stoich_o2(&self) -> f64 {
        1.0 + self.hydrogen_carbon / 4.0 - self.oxygen_carbon / 2.0
    }
    fn fuel_molar_mass(&self) -> f64 {
        M_C + self.hydrogen_carbon * M_H + self.oxygen_carbon * M_O
    }
    /// Stoichiometric air/fuel mass ratio for the declared composition.
    pub fn stoich_afr(&self) -> f64 {
        let air_mass_per_o2: f64 = AIR.iter().map(|(s, x)| x * s.molar_mass).sum::<f64>() / AIR[1].1;
        self.stoich_o2() * air_mass_per_o2 / self.fuel_molar_mass()
    }
    /// Complete combustion when lean; rich products split CO/H2 by water-gas-shift
    /// equilibrium evaluated from the same NASA data at `WGS_FREEZE_K`. No
    /// dissociation, unburned fuel, NO or minor species.
    pub fn products(&self, phi: f64, lhv_jkg: f64) -> Products {
        let y = self.hydrogen_carbon;
        let a = self.stoich_o2() / phi; // mol O2 per mol fuel carbon
        let air_scale = a / AIR[1].1;
        let mut parts: Vec<(Species, f64)> =
            vec![(N2, air_scale * AIR[0].1), (AR, air_scale * AIR[2].1)];
        let air_co2 = air_scale * AIR[3].1;
        let mut lost = 0.0;
        if phi <= 1.0 {
            parts.extend([(CO2, 1.0 + air_co2), (H2O, y / 2.0), (O2, a - self.stoich_o2())]);
        } else {
            // c=CO, h=H2: c+h=d; K=c(y/2-h)/((1-c)h) -> (1-K)c^2+(y/2-d+K+Kd)c-Kd=0
            let d = 2.0 * (self.stoich_o2() - a);
            let k = wgs_constant(WGS_FREEZE_K);
            let (qa, qb, qc) = (1.0 - k, y / 2.0 - d + k + k * d, -k * d);
            let c = (-qb + (qb * qb - 4.0 * qa * qc).sqrt()) / (2.0 * qa);
            let c = c.clamp(0.0, d.min(1.0));
            let h = d - c;
            parts.extend([(CO2, 1.0 - c + air_co2), (CO, c), (H2O, y / 2.0 - h), (H2, h)]);
            // Heat of combustion still held by CO and H2 (298.15 K, same data set).
            let co_loss = molar_h(&CO2, T_REF) - molar_h(&CO, T_REF) - 0.5 * molar_h(&O2, T_REF);
            let h2_loss = molar_h(&H2O, T_REF) - molar_h(&H2, T_REF) - 0.5 * molar_h(&O2, T_REF);
            lost = -(c * co_loss + h * h2_loss);
        }
        let released_fraction = (1.0 - lost / (self.fuel_molar_mass() * lhv_jkg)).clamp(0.0, 1.0);
        Products { mixture: Mixture::from_moles(&parts), released_fraction, phi }
    }
}
/// Kp for CO2 + H2 <-> CO + H2O from NASA-7 Gibbs functions.
pub fn wgs_constant(t: f64) -> f64 {
    let g = |s: &Species| h_over_r(coeffs(s, t), t) / t - s_over_r(coeffs(s, t), t);
    (-(g(&CO) + g(&H2O) - g(&CO2) - g(&H2))).exp()
}

/// Mass-weighted blend of fresh air (`fresh` fraction) and burned products.
pub struct Blend<'a> {
    pub air: &'a Mixture,
    pub burned: &'a Mixture,
    pub fresh: f64,
}
impl Blend<'_> {
    pub fn gas_r(&self) -> f64 {
        self.fresh * self.air.gas_r + (1.0 - self.fresh) * self.burned.gas_r
    }
    pub fn u(&self, t: f64) -> f64 {
        self.fresh * self.air.u(t) + (1.0 - self.fresh) * self.burned.u(t)
    }
    pub fn h(&self, t: f64) -> f64 {
        self.fresh * self.air.h(t) + (1.0 - self.fresh) * self.burned.h(t)
    }
    pub fn cp(&self, t: f64) -> f64 {
        self.fresh * self.air.cp(t) + (1.0 - self.fresh) * self.burned.cp(t)
    }
    pub fn gamma(&self, t: f64) -> f64 {
        let cp = self.cp(t);
        cp / (cp - self.gas_r())
    }
    /// Safeguarded Newton/bisection inversion of u(T)=e on [T_MIN, T_MAX].
    /// Returns None outside the coefficient domain or if cv is not positive.
    pub fn temperature(&self, e: f64) -> Option<f64> {
        let (mut lo, mut hi) = (T_MIN, T_MAX);
        if !e.is_finite() || e < self.u(lo) || e > self.u(hi) {
            return None;
        }
        let mut t = (T_REF + (e + self.gas_r() * T_REF) / (self.cp(800.0) - self.gas_r())).clamp(lo, hi);
        for _ in 0..60 {
            let f = self.u(t) - e;
            let cv = self.cp(t) - self.gas_r();
            if cv <= 0.0 {
                return None;
            }
            if f > 0.0 { hi = t } else { lo = t }
            let next = t - f / cv;
            let next = if next > lo && next < hi { next } else { 0.5 * (lo + hi) };
            if (next - t).abs() <= 1e-10 * t {
                return Some(next);
            }
            t = next;
        }
        Some(t)
    }
}
