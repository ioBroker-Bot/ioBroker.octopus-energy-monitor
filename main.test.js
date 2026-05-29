'use strict';

const { expect } = require('chai');

// Mock @iobroker/adapter-core so that requiring main.js doesn't boot the real ioBroker system
// @ts-ignore
require.cache[require.resolve('@iobroker/adapter-core')] = {
	exports: {
		Adapter: class MockAdapter {
			constructor() {
				this.log = {
					info: () => {},
					warn: () => {},
					error: () => {},
					debug: () => {},
				};
			}
			on() {}
		},
	},
};

const factory = require('./main.js');
const adapter = factory({});

describe('§14a EnWG Tariff Resolution & Validation Tests', () => {
	describe('validateEnwgConfig', () => {
		it('should return valid if EnWG is disabled', () => {
			const config = { enwgEnabled: false };
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.true;
		});

		it('should return invalid if EnWG is enabled but no windows configured', () => {
			const config = { enwgEnabled: true, enwgTimeWindows: [] };
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.false;
			expect(result.error).to.include('No time windows configured');
		});

		it('should return valid for non-overlapping windows', () => {
			const config = {
				enwgEnabled: true,
				enwgTimeWindows: [
					{ tariff: 'NT', months: '*', startTime: '00:00', endTime: '06:00' },
					{ tariff: 'ST', months: '*', startTime: '06:00', endTime: '22:00' },
					{ tariff: 'HT', months: '*', startTime: '22:00', endTime: '24:00' },
				],
			};
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.true;
		});

		it('should return invalid for overlapping windows within the same month', () => {
			const config = {
				enwgEnabled: true,
				enwgTimeWindows: [
					{ tariff: 'NT', months: '1,2,3', startTime: '12:00', endTime: '14:00' },
					{ tariff: 'ST', months: '3,4', startTime: '13:00', endTime: '15:00' },
				],
			};
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.false;
			expect(result.error).to.include('Overlap detected in month 3');
		});

		it('should handle wildcard * active months correctly', () => {
			const config = {
				enwgEnabled: true,
				enwgTimeWindows: [
					{ tariff: 'NT', months: '*', startTime: '12:00', endTime: '14:00' },
					{ tariff: 'ST', months: '6', startTime: '13:00', endTime: '15:00' },
				],
			};
			const result = adapter.validateEnwgConfig(config);
			expect(result.valid).to.be.false;
			expect(result.error).to.include('Overlap detected in month 6');
		});
	});

	describe('getEnwgTariffForTime', () => {
		const config = {
			enwgEnabled: true,
			enwgTimeWindows: [
				{ tariff: 'NT', months: '1,2,11,12', startTime: '00:00', endTime: '06:00' },
				{ tariff: 'HT', months: '1,2,11,12', startTime: '17:00', endTime: '19:00' },
				{ tariff: 'ST', months: '*', startTime: '00:00', endTime: '24:00' }, // ST fallback window
			],
		};

		it('should return NT during winter months and late night', () => {
			const testDate = new Date(2026, 0, 15, 3, 30); // Jan 15th, 03:30
			const tariff = adapter.getEnwgTariffForTime(testDate, config);
			expect(tariff).to.equal('NT');
		});

		it('should return HT during winter months peak hours', () => {
			const testDate = new Date(2026, 0, 15, 18, 15); // Jan 15th, 18:15
			const tariff = adapter.getEnwgTariffForTime(testDate, config);
			expect(tariff).to.equal('HT');
		});

		it('should return ST during summer months even at late night (as NT is only winter)', () => {
			const testDate = new Date(2026, 5, 15, 3, 30); // June 15th, 03:30
			const tariff = adapter.getEnwgTariffForTime(testDate, config);
			expect(tariff).to.equal('ST');
		});
	});

	describe('getTariffSegmentsForDay', () => {
		const config = {
			enwgEnabled: true,
			enwgTimeWindows: [
				{ tariff: 'NT', months: '1,2,11,12', startTime: '00:00', endTime: '06:00' },
				{ tariff: 'HT', months: '1,2,11,12', startTime: '17:00', endTime: '19:00' },
				{ tariff: 'ST', months: '*', startTime: '00:00', endTime: '24:00' },
			],
		};

		it('should group 15-minute slots into correct daily segments', () => {
			const testDate = new Date(2026, 0, 15); // Jan 15th
			const segments = adapter.getTariffSegmentsForDay(testDate, config);

			// Expected:
			// NT: 00:00 (0m) to 06:00 (360m)
			// HT: 17:00 (1020m) to 19:00 (1140m)
			// ST: 06:00 (360m) to 17:00 (1020m) AND 19:00 (1140m) to 24:00 (1440m)
			expect(segments.NT).to.have.lengthOf(1);
			expect(segments.NT[0]).to.deep.equal({ fromMin: 0, toMin: 360 });

			expect(segments.HT).to.have.lengthOf(1);
			expect(segments.HT[0]).to.deep.equal({ fromMin: 1020, toMin: 1140 });

			expect(segments.ST).to.have.lengthOf(2);
			expect(segments.ST[0]).to.deep.equal({ fromMin: 360, toMin: 1020 });
			expect(segments.ST[1]).to.deep.equal({ fromMin: 1140, toMin: 1440 });
		});
	});

	describe('isEnwgActiveForDate', () => {
		it('should return false if enwgEnabled is false', () => {
			adapter.enwgEnabled = false;
			const config = { enwgStartDate: '2026-01-01' };
			const result = adapter.isEnwgActiveForDate(new Date(2026, 0, 5), config);
			expect(result).to.be.false;
		});

		it('should return false if enwgStartDate is invalid format', () => {
			adapter.enwgEnabled = true;
			const config = { enwgStartDate: 'invalid-date' };
			const result = adapter.isEnwgActiveForDate(new Date(2026, 0, 5), config);
			expect(result).to.be.false;
		});

		it('should return true for dates >= enwgStartDate', () => {
			adapter.enwgEnabled = true;
			const config = { enwgStartDate: '2026-05-10' };

			expect(adapter.isEnwgActiveForDate(new Date(2026, 4, 9), config)).to.be.false; // May 9
			expect(adapter.isEnwgActiveForDate(new Date(2026, 4, 10), config)).to.be.true; // May 10
			expect(adapter.isEnwgActiveForDate(new Date(2026, 4, 11), config)).to.be.true; // May 11
		});
	});

	describe('getEnwgGridFees', () => {
		it('should calculate gross and net prices correctly when inputs are net', () => {
			const config = {
				enwgGridFeeSt: 0.10,
				enwgGridFeeNt: 0.05,
				enwgGridFeeHt: 0.15,
				enwgGridFeesAreGross: false,
			};
			const result = adapter.getEnwgGridFees(config);
			expect(result.ST.net).to.equal(0.10);
			expect(result.ST.gross).to.be.closeTo(0.119, 0.0001);
			expect(result.NT.net).to.equal(0.05);
			expect(result.NT.gross).to.be.closeTo(0.0595, 0.0001);
			expect(result.HT.net).to.equal(0.15);
			expect(result.HT.gross).to.be.closeTo(0.1785, 0.0001);
		});

		it('should calculate gross and net prices correctly when inputs are gross', () => {
			const config = {
				enwgGridFeeSt: 0.119,
				enwgGridFeeNt: 0.0595,
				enwgGridFeeHt: 0.1785,
				enwgGridFeesAreGross: true,
			};
			const result = adapter.getEnwgGridFees(config);
			expect(result.ST.gross).to.equal(0.119);
			expect(result.ST.net).to.be.closeTo(0.10, 0.0001);
			expect(result.NT.gross).to.equal(0.0595);
			expect(result.NT.net).to.be.closeTo(0.05, 0.0001);
			expect(result.HT.gross).to.equal(0.1785);
			expect(result.HT.net).to.be.closeTo(0.15, 0.0001);
		});

		it('should parse strings with dots or commas as decimal separators correctly', () => {
			const config = {
				enwgGridFeeSt: "0,10",
				enwgGridFeeNt: "0.05",
				enwgGridFeeHt: "  0,15  ",
				enwgGridFeesAreGross: false,
			};
			const result = adapter.getEnwgGridFees(config);
			expect(result.ST.net).to.equal(0.10);
			expect(result.NT.net).to.equal(0.05);
			expect(result.HT.net).to.equal(0.15);
		});
	});
});
