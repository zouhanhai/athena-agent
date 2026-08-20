sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageBox"
], function (Controller, MessageBox) {
  "use strict";

  return Controller.extend("com.caleo.consolidation.controller.Dashboard", {
    onInit: function () {
      var oModel = this.getOwnerComponent().getModel("consolidationService");
      this.getView().setModel(oModel);
    },

    onTilePress: function (oEvent) {
      var sTileId = oEvent.getSource().getId();
      var oRouter = this.getOwnerComponent().getRouter();
      oRouter.navTo("consolidation", { view: sTileId });
    }
  });
});
