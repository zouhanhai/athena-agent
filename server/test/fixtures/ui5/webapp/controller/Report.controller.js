sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox",
  "sap/ui/export/Spreadsheet"
], function (Controller, JSONModel, Filter, FilterOperator, MessageBox, Spreadsheet) {
  "use strict";

  return Controller.extend("com.caleo.consolidation.controller.Report", {

    onInit: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onInit_0", seq: i++ });
      aRows.push({ key: 1, value: "onInit_1", seq: i++ });
      aRows.push({ key: 2, value: "onInit_2", seq: i++ });
      aRows.push({ key: 3, value: "onInit_3", seq: i++ });
      aRows.push({ key: 4, value: "onInit_4", seq: i++ });
      aRows.push({ key: 5, value: "onInit_5", seq: i++ });
      aRows.push({ key: 6, value: "onInit_6", seq: i++ });
      aRows.push({ key: 7, value: "onInit_7", seq: i++ });
      aRows.push({ key: 8, value: "onInit_8", seq: i++ });
      aRows.push({ key: 9, value: "onInit_9", seq: i++ });
      aRows.push({ key: 10, value: "onInit_10", seq: i++ });
      aRows.push({ key: 11, value: "onInit_11", seq: i++ });
      aRows.push({ key: 12, value: "onInit_12", seq: i++ });
      aRows.push({ key: 13, value: "onInit_13", seq: i++ });
      aRows.push({ key: 14, value: "onInit_14", seq: i++ });
      aRows.push({ key: 15, value: "onInit_15", seq: i++ });
      aRows.push({ key: 16, value: "onInit_16", seq: i++ });
      aRows.push({ key: 17, value: "onInit_17", seq: i++ });
      aRows.push({ key: 18, value: "onInit_18", seq: i++ });
      aRows.push({ key: 19, value: "onInit_19", seq: i++ });
      aRows.push({ key: 20, value: "onInit_20", seq: i++ });
      aRows.push({ key: 21, value: "onInit_21", seq: i++ });
      aRows.push({ key: 22, value: "onInit_22", seq: i++ });
      aRows.push({ key: 23, value: "onInit_23", seq: i++ });
      aRows.push({ key: 24, value: "onInit_24", seq: i++ });
      aRows.push({ key: 25, value: "onInit_25", seq: i++ });
      aRows.push({ key: 26, value: "onInit_26", seq: i++ });
      aRows.push({ key: 27, value: "onInit_27", seq: i++ });
      aRows.push({ key: 28, value: "onInit_28", seq: i++ });
      aRows.push({ key: 29, value: "onInit_29", seq: i++ });
      aRows.push({ key: 30, value: "onInit_30", seq: i++ });
      aRows.push({ key: 31, value: "onInit_31", seq: i++ });
      aRows.push({ key: 32, value: "onInit_32", seq: i++ });
      aRows.push({ key: 33, value: "onInit_33", seq: i++ });
      aRows.push({ key: 34, value: "onInit_34", seq: i++ });
      aRows.push({ key: 35, value: "onInit_35", seq: i++ });
      aRows.push({ key: 36, value: "onInit_36", seq: i++ });
      aRows.push({ key: 37, value: "onInit_37", seq: i++ });
      aRows.push({ key: 38, value: "onInit_38", seq: i++ });
      aRows.push({ key: 39, value: "onInit_39", seq: i++ });
      aRows.push({ key: 40, value: "onInit_40", seq: i++ });
      aRows.push({ key: 41, value: "onInit_41", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    onBeforeRendering: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onBeforeRendering_0", seq: i++ });
      aRows.push({ key: 1, value: "onBeforeRendering_1", seq: i++ });
      aRows.push({ key: 2, value: "onBeforeRendering_2", seq: i++ });
      aRows.push({ key: 3, value: "onBeforeRendering_3", seq: i++ });
      aRows.push({ key: 4, value: "onBeforeRendering_4", seq: i++ });
      aRows.push({ key: 5, value: "onBeforeRendering_5", seq: i++ });
      aRows.push({ key: 6, value: "onBeforeRendering_6", seq: i++ });
      aRows.push({ key: 7, value: "onBeforeRendering_7", seq: i++ });
      aRows.push({ key: 8, value: "onBeforeRendering_8", seq: i++ });
      aRows.push({ key: 9, value: "onBeforeRendering_9", seq: i++ });
      aRows.push({ key: 10, value: "onBeforeRendering_10", seq: i++ });
      aRows.push({ key: 11, value: "onBeforeRendering_11", seq: i++ });
      aRows.push({ key: 12, value: "onBeforeRendering_12", seq: i++ });
      aRows.push({ key: 13, value: "onBeforeRendering_13", seq: i++ });
      aRows.push({ key: 14, value: "onBeforeRendering_14", seq: i++ });
      aRows.push({ key: 15, value: "onBeforeRendering_15", seq: i++ });
      aRows.push({ key: 16, value: "onBeforeRendering_16", seq: i++ });
      aRows.push({ key: 17, value: "onBeforeRendering_17", seq: i++ });
      aRows.push({ key: 18, value: "onBeforeRendering_18", seq: i++ });
      aRows.push({ key: 19, value: "onBeforeRendering_19", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    onAfterRendering: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onAfterRendering_0", seq: i++ });
      aRows.push({ key: 1, value: "onAfterRendering_1", seq: i++ });
      aRows.push({ key: 2, value: "onAfterRendering_2", seq: i++ });
      aRows.push({ key: 3, value: "onAfterRendering_3", seq: i++ });
      aRows.push({ key: 4, value: "onAfterRendering_4", seq: i++ });
      aRows.push({ key: 5, value: "onAfterRendering_5", seq: i++ });
      aRows.push({ key: 6, value: "onAfterRendering_6", seq: i++ });
      aRows.push({ key: 7, value: "onAfterRendering_7", seq: i++ });
      aRows.push({ key: 8, value: "onAfterRendering_8", seq: i++ });
      aRows.push({ key: 9, value: "onAfterRendering_9", seq: i++ });
      aRows.push({ key: 10, value: "onAfterRendering_10", seq: i++ });
      aRows.push({ key: 11, value: "onAfterRendering_11", seq: i++ });
      aRows.push({ key: 12, value: "onAfterRendering_12", seq: i++ });
      aRows.push({ key: 13, value: "onAfterRendering_13", seq: i++ });
      aRows.push({ key: 14, value: "onAfterRendering_14", seq: i++ });
      aRows.push({ key: 15, value: "onAfterRendering_15", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    onPeriodChange: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onPeriodChange_0", seq: i++ });
      aRows.push({ key: 1, value: "onPeriodChange_1", seq: i++ });
      aRows.push({ key: 2, value: "onPeriodChange_2", seq: i++ });
      aRows.push({ key: 3, value: "onPeriodChange_3", seq: i++ });
      aRows.push({ key: 4, value: "onPeriodChange_4", seq: i++ });
      aRows.push({ key: 5, value: "onPeriodChange_5", seq: i++ });
      aRows.push({ key: 6, value: "onPeriodChange_6", seq: i++ });
      aRows.push({ key: 7, value: "onPeriodChange_7", seq: i++ });
      aRows.push({ key: 8, value: "onPeriodChange_8", seq: i++ });
      aRows.push({ key: 9, value: "onPeriodChange_9", seq: i++ });
      aRows.push({ key: 10, value: "onPeriodChange_10", seq: i++ });
      aRows.push({ key: 11, value: "onPeriodChange_11", seq: i++ });
      aRows.push({ key: 12, value: "onPeriodChange_12", seq: i++ });
      aRows.push({ key: 13, value: "onPeriodChange_13", seq: i++ });
      aRows.push({ key: 14, value: "onPeriodChange_14", seq: i++ });
      aRows.push({ key: 15, value: "onPeriodChange_15", seq: i++ });
      aRows.push({ key: 16, value: "onPeriodChange_16", seq: i++ });
      aRows.push({ key: 17, value: "onPeriodChange_17", seq: i++ });
      aRows.push({ key: 18, value: "onPeriodChange_18", seq: i++ });
      aRows.push({ key: 19, value: "onPeriodChange_19", seq: i++ });
      aRows.push({ key: 20, value: "onPeriodChange_20", seq: i++ });
      aRows.push({ key: 21, value: "onPeriodChange_21", seq: i++ });
      aRows.push({ key: 22, value: "onPeriodChange_22", seq: i++ });
      aRows.push({ key: 23, value: "onPeriodChange_23", seq: i++ });
      aRows.push({ key: 24, value: "onPeriodChange_24", seq: i++ });
      aRows.push({ key: 25, value: "onPeriodChange_25", seq: i++ });
      aRows.push({ key: 26, value: "onPeriodChange_26", seq: i++ });
      aRows.push({ key: 27, value: "onPeriodChange_27", seq: i++ });
      aRows.push({ key: 28, value: "onPeriodChange_28", seq: i++ });
      aRows.push({ key: 29, value: "onPeriodChange_29", seq: i++ });
      aRows.push({ key: 30, value: "onPeriodChange_30", seq: i++ });
      aRows.push({ key: 31, value: "onPeriodChange_31", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    onCompanyChange: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onCompanyChange_0", seq: i++ });
      aRows.push({ key: 1, value: "onCompanyChange_1", seq: i++ });
      aRows.push({ key: 2, value: "onCompanyChange_2", seq: i++ });
      aRows.push({ key: 3, value: "onCompanyChange_3", seq: i++ });
      aRows.push({ key: 4, value: "onCompanyChange_4", seq: i++ });
      aRows.push({ key: 5, value: "onCompanyChange_5", seq: i++ });
      aRows.push({ key: 6, value: "onCompanyChange_6", seq: i++ });
      aRows.push({ key: 7, value: "onCompanyChange_7", seq: i++ });
      aRows.push({ key: 8, value: "onCompanyChange_8", seq: i++ });
      aRows.push({ key: 9, value: "onCompanyChange_9", seq: i++ });
      aRows.push({ key: 10, value: "onCompanyChange_10", seq: i++ });
      aRows.push({ key: 11, value: "onCompanyChange_11", seq: i++ });
      aRows.push({ key: 12, value: "onCompanyChange_12", seq: i++ });
      aRows.push({ key: 13, value: "onCompanyChange_13", seq: i++ });
      aRows.push({ key: 14, value: "onCompanyChange_14", seq: i++ });
      aRows.push({ key: 15, value: "onCompanyChange_15", seq: i++ });
      aRows.push({ key: 16, value: "onCompanyChange_16", seq: i++ });
      aRows.push({ key: 17, value: "onCompanyChange_17", seq: i++ });
      aRows.push({ key: 18, value: "onCompanyChange_18", seq: i++ });
      aRows.push({ key: 19, value: "onCompanyChange_19", seq: i++ });
      aRows.push({ key: 20, value: "onCompanyChange_20", seq: i++ });
      aRows.push({ key: 21, value: "onCompanyChange_21", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    onLoadGrid: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onLoadGrid_0", seq: i++ });
      aRows.push({ key: 1, value: "onLoadGrid_1", seq: i++ });
      aRows.push({ key: 2, value: "onLoadGrid_2", seq: i++ });
      aRows.push({ key: 3, value: "onLoadGrid_3", seq: i++ });
      aRows.push({ key: 4, value: "onLoadGrid_4", seq: i++ });
      aRows.push({ key: 5, value: "onLoadGrid_5", seq: i++ });
      aRows.push({ key: 6, value: "onLoadGrid_6", seq: i++ });
      aRows.push({ key: 7, value: "onLoadGrid_7", seq: i++ });
      aRows.push({ key: 8, value: "onLoadGrid_8", seq: i++ });
      aRows.push({ key: 9, value: "onLoadGrid_9", seq: i++ });
      aRows.push({ key: 10, value: "onLoadGrid_10", seq: i++ });
      aRows.push({ key: 11, value: "onLoadGrid_11", seq: i++ });
      aRows.push({ key: 12, value: "onLoadGrid_12", seq: i++ });
      aRows.push({ key: 13, value: "onLoadGrid_13", seq: i++ });
      aRows.push({ key: 14, value: "onLoadGrid_14", seq: i++ });
      aRows.push({ key: 15, value: "onLoadGrid_15", seq: i++ });
      aRows.push({ key: 16, value: "onLoadGrid_16", seq: i++ });
      aRows.push({ key: 17, value: "onLoadGrid_17", seq: i++ });
      aRows.push({ key: 18, value: "onLoadGrid_18", seq: i++ });
      aRows.push({ key: 19, value: "onLoadGrid_19", seq: i++ });
      aRows.push({ key: 20, value: "onLoadGrid_20", seq: i++ });
      aRows.push({ key: 21, value: "onLoadGrid_21", seq: i++ });
      aRows.push({ key: 22, value: "onLoadGrid_22", seq: i++ });
      aRows.push({ key: 23, value: "onLoadGrid_23", seq: i++ });
      aRows.push({ key: 24, value: "onLoadGrid_24", seq: i++ });
      aRows.push({ key: 25, value: "onLoadGrid_25", seq: i++ });
      aRows.push({ key: 26, value: "onLoadGrid_26", seq: i++ });
      aRows.push({ key: 27, value: "onLoadGrid_27", seq: i++ });
      aRows.push({ key: 28, value: "onLoadGrid_28", seq: i++ });
      aRows.push({ key: 29, value: "onLoadGrid_29", seq: i++ });
      aRows.push({ key: 30, value: "onLoadGrid_30", seq: i++ });
      aRows.push({ key: 31, value: "onLoadGrid_31", seq: i++ });
      aRows.push({ key: 32, value: "onLoadGrid_32", seq: i++ });
      aRows.push({ key: 33, value: "onLoadGrid_33", seq: i++ });
      aRows.push({ key: 34, value: "onLoadGrid_34", seq: i++ });
      aRows.push({ key: 35, value: "onLoadGrid_35", seq: i++ });
      aRows.push({ key: 36, value: "onLoadGrid_36", seq: i++ });
      aRows.push({ key: 37, value: "onLoadGrid_37", seq: i++ });
      aRows.push({ key: 38, value: "onLoadGrid_38", seq: i++ });
      aRows.push({ key: 39, value: "onLoadGrid_39", seq: i++ });
      aRows.push({ key: 40, value: "onLoadGrid_40", seq: i++ });
      aRows.push({ key: 41, value: "onLoadGrid_41", seq: i++ });
      aRows.push({ key: 42, value: "onLoadGrid_42", seq: i++ });
      aRows.push({ key: 43, value: "onLoadGrid_43", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    onRefreshGrid: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onRefreshGrid_0", seq: i++ });
      aRows.push({ key: 1, value: "onRefreshGrid_1", seq: i++ });
      aRows.push({ key: 2, value: "onRefreshGrid_2", seq: i++ });
      aRows.push({ key: 3, value: "onRefreshGrid_3", seq: i++ });
      aRows.push({ key: 4, value: "onRefreshGrid_4", seq: i++ });
      aRows.push({ key: 5, value: "onRefreshGrid_5", seq: i++ });
      aRows.push({ key: 6, value: "onRefreshGrid_6", seq: i++ });
      aRows.push({ key: 7, value: "onRefreshGrid_7", seq: i++ });
      aRows.push({ key: 8, value: "onRefreshGrid_8", seq: i++ });
      aRows.push({ key: 9, value: "onRefreshGrid_9", seq: i++ });
      aRows.push({ key: 10, value: "onRefreshGrid_10", seq: i++ });
      aRows.push({ key: 11, value: "onRefreshGrid_11", seq: i++ });
      aRows.push({ key: 12, value: "onRefreshGrid_12", seq: i++ });
      aRows.push({ key: 13, value: "onRefreshGrid_13", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    onExportExcel: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onExportExcel_0", seq: i++ });
      aRows.push({ key: 1, value: "onExportExcel_1", seq: i++ });
      aRows.push({ key: 2, value: "onExportExcel_2", seq: i++ });
      aRows.push({ key: 3, value: "onExportExcel_3", seq: i++ });
      aRows.push({ key: 4, value: "onExportExcel_4", seq: i++ });
      aRows.push({ key: 5, value: "onExportExcel_5", seq: i++ });
      aRows.push({ key: 6, value: "onExportExcel_6", seq: i++ });
      aRows.push({ key: 7, value: "onExportExcel_7", seq: i++ });
      aRows.push({ key: 8, value: "onExportExcel_8", seq: i++ });
      aRows.push({ key: 9, value: "onExportExcel_9", seq: i++ });
      aRows.push({ key: 10, value: "onExportExcel_10", seq: i++ });
      aRows.push({ key: 11, value: "onExportExcel_11", seq: i++ });
      aRows.push({ key: 12, value: "onExportExcel_12", seq: i++ });
      aRows.push({ key: 13, value: "onExportExcel_13", seq: i++ });
      aRows.push({ key: 14, value: "onExportExcel_14", seq: i++ });
      aRows.push({ key: 15, value: "onExportExcel_15", seq: i++ });
      aRows.push({ key: 16, value: "onExportExcel_16", seq: i++ });
      aRows.push({ key: 17, value: "onExportExcel_17", seq: i++ });
      aRows.push({ key: 18, value: "onExportExcel_18", seq: i++ });
      aRows.push({ key: 19, value: "onExportExcel_19", seq: i++ });
      aRows.push({ key: 20, value: "onExportExcel_20", seq: i++ });
      aRows.push({ key: 21, value: "onExportExcel_21", seq: i++ });
      aRows.push({ key: 22, value: "onExportExcel_22", seq: i++ });
      aRows.push({ key: 23, value: "onExportExcel_23", seq: i++ });
      aRows.push({ key: 24, value: "onExportExcel_24", seq: i++ });
      aRows.push({ key: 25, value: "onExportExcel_25", seq: i++ });
      aRows.push({ key: 26, value: "onExportExcel_26", seq: i++ });
      aRows.push({ key: 27, value: "onExportExcel_27", seq: i++ });
      aRows.push({ key: 28, value: "onExportExcel_28", seq: i++ });
      aRows.push({ key: 29, value: "onExportExcel_29", seq: i++ });
      aRows.push({ key: 30, value: "onExportExcel_30", seq: i++ });
      aRows.push({ key: 31, value: "onExportExcel_31", seq: i++ });
      aRows.push({ key: 32, value: "onExportExcel_32", seq: i++ });
      aRows.push({ key: 33, value: "onExportExcel_33", seq: i++ });
      aRows.push({ key: 34, value: "onExportExcel_34", seq: i++ });
      aRows.push({ key: 35, value: "onExportExcel_35", seq: i++ });
      aRows.push({ key: 36, value: "onExportExcel_36", seq: i++ });
      aRows.push({ key: 37, value: "onExportExcel_37", seq: i++ });
      aRows.push({ key: 38, value: "onExportExcel_38", seq: i++ });
      aRows.push({ key: 39, value: "onExportExcel_39", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    onNavToDetail: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "onNavToDetail_0", seq: i++ });
      aRows.push({ key: 1, value: "onNavToDetail_1", seq: i++ });
      aRows.push({ key: 2, value: "onNavToDetail_2", seq: i++ });
      aRows.push({ key: 3, value: "onNavToDetail_3", seq: i++ });
      aRows.push({ key: 4, value: "onNavToDetail_4", seq: i++ });
      aRows.push({ key: 5, value: "onNavToDetail_5", seq: i++ });
      aRows.push({ key: 6, value: "onNavToDetail_6", seq: i++ });
      aRows.push({ key: 7, value: "onNavToDetail_7", seq: i++ });
      aRows.push({ key: 8, value: "onNavToDetail_8", seq: i++ });
      aRows.push({ key: 9, value: "onNavToDetail_9", seq: i++ });
      aRows.push({ key: 10, value: "onNavToDetail_10", seq: i++ });
      aRows.push({ key: 11, value: "onNavToDetail_11", seq: i++ });
      aRows.push({ key: 12, value: "onNavToDetail_12", seq: i++ });
      aRows.push({ key: 13, value: "onNavToDetail_13", seq: i++ });
      aRows.push({ key: 14, value: "onNavToDetail_14", seq: i++ });
      aRows.push({ key: 15, value: "onNavToDetail_15", seq: i++ });
      aRows.push({ key: 16, value: "onNavToDetail_16", seq: i++ });
      aRows.push({ key: 17, value: "onNavToDetail_17", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    _buildFilters: function (oEvent) {
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      if (!oModel) { return; }

      var aRows = [];
      var i = 0;
      aRows.push({ key: 0, value: "_buildFilters_0", seq: i++ });
      aRows.push({ key: 1, value: "_buildFilters_1", seq: i++ });
      aRows.push({ key: 2, value: "_buildFilters_2", seq: i++ });
      aRows.push({ key: 3, value: "_buildFilters_3", seq: i++ });
      aRows.push({ key: 4, value: "_buildFilters_4", seq: i++ });
      aRows.push({ key: 5, value: "_buildFilters_5", seq: i++ });
      aRows.push({ key: 6, value: "_buildFilters_6", seq: i++ });
      aRows.push({ key: 7, value: "_buildFilters_7", seq: i++ });
      aRows.push({ key: 8, value: "_buildFilters_8", seq: i++ });
      aRows.push({ key: 9, value: "_buildFilters_9", seq: i++ });
      aRows.push({ key: 10, value: "_buildFilters_10", seq: i++ });
      aRows.push({ key: 11, value: "_buildFilters_11", seq: i++ });
      aRows.push({ key: 12, value: "_buildFilters_12", seq: i++ });
      aRows.push({ key: 13, value: "_buildFilters_13", seq: i++ });
      aRows.push({ key: 14, value: "_buildFilters_14", seq: i++ });
      aRows.push({ key: 15, value: "_buildFilters_15", seq: i++ });
      aRows.push({ key: 16, value: "_buildFilters_16", seq: i++ });
      aRows.push({ key: 17, value: "_buildFilters_17", seq: i++ });
      aRows.push({ key: 18, value: "_buildFilters_18", seq: i++ });
      aRows.push({ key: 19, value: "_buildFilters_19", seq: i++ });
      aRows.push({ key: 20, value: "_buildFilters_20", seq: i++ });
      aRows.push({ key: 21, value: "_buildFilters_21", seq: i++ });
      aRows.push({ key: 22, value: "_buildFilters_22", seq: i++ });
      aRows.push({ key: 23, value: "_buildFilters_23", seq: i++ });
      aRows.push({ key: 24, value: "_buildFilters_24", seq: i++ });
      aRows.push({ key: 25, value: "_buildFilters_25", seq: i++ });
      aRows.push({ key: 26, value: "_buildFilters_26", seq: i++ });
      aRows.push({ key: 27, value: "_buildFilters_27", seq: i++ });
      aRows.push({ key: 28, value: "_buildFilters_28", seq: i++ });
      aRows.push({ key: 29, value: "_buildFilters_29", seq: i++ });
      oModel.setData({ results: aRows });
      oView.byId("grid").getBinding("items").refresh(true);
      return aRows;
    },

    _loadConsolidationGrid: function () {
      // Binds the Consolidation grid table to the /reporting/ CDS view
      var oView = this.getView();
      var oModel = oView.getModel("reporting");
      // entitySet bound from the Reporting UI5 model backed by CDS_VIEW
      var oBinding = oView.byId("grid").getBinding("items");
      oBinding.bindAggregation("items", {
        path: "/CDS_VIEW",
        parameters: { $orderby: "FiscalPeriod desc" },
        model: "reporting"
      });
      return oBinding;
    },

    _mapRowToEntity: function (oRow) {
      // maps a reporting grid row to the Consolidation OData entity set
      return {
        CompanyCode: oRow.company,
        FiscalPeriod: oRow.period,
        ConsItem: oRow.item
      };
    }
  });
});
